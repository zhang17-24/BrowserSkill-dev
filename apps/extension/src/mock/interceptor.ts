import type { MockRule } from "@/transport/types";
import { findMatchingRule } from "./matcher";
import { decodeRuleBody, headersFromRule, toResponse } from "./response";

/**
 * The page-side request interceptor.
 *
 * Runs in the page's own JavaScript context (MAIN world) and replaces
 * `window.fetch` and `XMLHttpRequest` so a matched request never reaches the
 * network. That is the whole point: the origin server does not see the
 * request, so no CORS preflight happens and HTTPS needs no certificate.
 *
 * Scope, stated plainly because it decides which requests are reachable:
 * this only sees requests the **page's own JavaScript** issues through
 * `fetch` or `XMLHttpRequest`. It does not see `<img>` / `<script>` / CSS /
 * document navigations, and it does not see requests a Service Worker makes.
 * Those need the declarative-net-request channel instead.
 *
 * Everything the patch touches is injected, so the behaviour can be tested
 * against fakes rather than a real browser.
 */

export interface MockedRequestInfo {
  url: string;
  method: string;
  rule: MockRule;
}

export interface InterceptorDeps {
  /**
   * The rules in effect. Read per request rather than captured once, because
   * the rule set arrives asynchronously and can change while a page lives —
   * awaiting it here is what stops the page's very first request from
   * slipping through un-mocked.
   */
  getRules: () => MockRule[] | Promise<MockRule[]>;
  /** Injected so tests do not actually wait out `delay_ms`. */
  sleep: (ms: number) => Promise<void>;
  /** Observability hook; never allowed to affect the request. */
  onMocked?: (info: MockedRequestInfo) => void;
}

/** The globals the interceptor patches. */
export interface MockTarget {
  fetch: typeof globalThis.fetch;
  XMLHttpRequest: typeof globalThis.XMLHttpRequest;
  /**
   * Base for resolving relative request URLs.
   *
   * A function rather than a string because a single-page app changes
   * `location.href` via `pushState` without re-injecting the script; reading
   * it per request keeps `fetch("/api/x")` resolving against the URL the app
   * is actually on. Defaults to the live `location.href`.
   */
  getBaseUrl?: () => string;
}

function resolveBase(target: MockTarget): string {
  if (target.getBaseUrl) return target.getBaseUrl();
  return typeof globalThis.location?.href === "string" ? globalThis.location.href : "";
}

const INSTALLED = Symbol.for("bsk.mock.installed");

type MaybeInstalled = {
  [INSTALLED]?: () => void;
};

/**
 * Resolve a possibly-relative URL against the page's own URL.
 *
 * `fetch("/api/user")` is the common case in app code, and a rule is written
 * against the absolute URL the developer saw in DevTools, so the two must be
 * reconciled before matching.
 */
export function absoluteUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/**
 * Read the URL and method off a `fetch` call without constructing a `Request`.
 *
 * Constructing one would consume or clone the body, which changes observable
 * behaviour for the caller — so the shapes are read directly instead.
 */
export function describeFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  base: string,
): { url: string; method: string } {
  if (typeof input === "string") {
    return { url: absoluteUrl(input, base), method: (init?.method ?? "GET").toUpperCase() };
  }
  if (input instanceof URL) {
    return { url: input.href, method: (init?.method ?? "GET").toUpperCase() };
  }
  return {
    url: input.url,
    method: (init?.method ?? input.method ?? "GET").toUpperCase(),
  };
}

function defineValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

/** Canonical reason phrases, so a mocked 404 reads like a real one. */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function statusTextFor(status: number): string {
  return STATUS_TEXT[status] ?? "";
}

function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Install the interceptor on the given globals.
 *
 * Returns an uninstall function. Installing twice on the same target is a
 * no-op that returns the existing uninstall, so a script re-injected into a
 * frame cannot stack two patches and double-apply a delay.
 */
export function installMockInterceptor(target: MockTarget, deps: InterceptorDeps): () => void {
  const alreadyInstalled = (target.fetch as unknown as MaybeInstalled)[INSTALLED];
  if (alreadyInstalled) return alreadyInstalled;

  const originalFetch = target.fetch;
  const Xhr = target.XMLHttpRequest;
  const originalOpen = Xhr.prototype.open;
  const originalSend = Xhr.prototype.send;

  const requestMeta = new WeakMap<
    XMLHttpRequest,
    { url: string; method: string; isAsync: boolean }
  >();

  const patchedFetch = async function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let described: { url: string; method: string } | null = null;
    try {
      described = describeFetchRequest(input, init, resolveBase(target));
    } catch {
      described = null;
    }

    if (!described) return originalFetch.call(this, input, init);

    // Fail open: a rule table that cannot be read must not break the page.
    // The alternative — rejecting here — would turn a storage hiccup into an
    // application error the user cannot diagnose.
    let rules: MockRule[] = [];
    try {
      rules = await deps.getRules();
    } catch {
      return originalFetch.call(this, input, init);
    }

    const rule = findMatchingRule(rules, described.url, described.method);
    if (!rule) return originalFetch.call(this, input, init);

    if (rule.delay_ms !== undefined) await deps.sleep(rule.delay_ms);
    try {
      deps.onMocked?.({ url: described.url, method: described.method, rule });
    } catch {
      // Observability must never break the response.
    }

    return toResponse(rule);
  } as unknown as typeof globalThis.fetch;

  Xhr.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    requestMeta.set(this, {
      url: absoluteUrl(String(url), resolveBase(target)),
      method: String(method).toUpperCase(),
      isAsync: async !== false,
    });
    return originalOpen.call(this, method, url, async ?? true, username, password);
  } as typeof Xhr.prototype.open;

  Xhr.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = requestMeta.get(this);
    // Synchronous XHR cannot be deferred behind an await, and mocking it
    // would need a blocking rule lookup. Leave it on the real path.
    if (!meta || !meta.isAsync) return originalSend.call(this, body);

    const xhr = this;
    void (async () => {
      let rule: MockRule | null = null;
      try {
        const rules = await deps.getRules();
        rule = findMatchingRule(rules, meta.url, meta.method);
      } catch {
        rule = null;
      }

      if (!rule) {
        originalSend.call(xhr, body);
        return;
      }

      if (rule.delay_ms !== undefined) await deps.sleep(rule.delay_ms);
      try {
        deps.onMocked?.({ url: meta.url, method: meta.method, rule });
      } catch {
        // See above: observability never breaks the response.
      }
      fulfilXhr(xhr, rule, meta.url);
    })();

    return undefined;
  } as typeof Xhr.prototype.send;

  const uninstall = () => {
    target.fetch = originalFetch;
    Xhr.prototype.open = originalOpen;
    Xhr.prototype.send = originalSend;
  };

  // The marker lives on the *patched* function, which is what `target.fetch`
  // points at afterwards — so a second install finds it and no-ops.
  (patchedFetch as unknown as Record<symbol, unknown>)[INSTALLED] = uninstall;
  target.fetch = patchedFetch;

  return uninstall;
}

/**
 * Make a real `XMLHttpRequest` instance report a synthesised response.
 *
 * The properties are getters on the prototype, so an own property is defined
 * on the instance to shadow them.
 */
function fulfilXhr(xhr: XMLHttpRequest, rule: MockRule, url: string): void {
  const bytes = decodeRuleBody(rule);
  const headers = headersFromRule(rule);
  const text = rule.body_encoding === "base64" ? "" : rule.body;
  const responseType = xhr.responseType || "";

  defineValue(xhr, "status", rule.status);
  defineValue(xhr, "statusText", statusTextFor(rule.status));
  defineValue(xhr, "responseURL", url);
  defineValue(xhr, "getAllResponseHeaders", () => headerLines(headers));
  defineValue(xhr, "getResponseHeader", (name: string) => {
    const wanted = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return value;
    }
    return null;
  });

  switch (responseType) {
    case "json":
      defineValue(xhr, "response", parseJsonOrNull(text));
      break;
    case "arraybuffer": {
      const copy = bytes ? bytes.slice().buffer : new ArrayBuffer(0);
      defineValue(xhr, "response", copy);
      break;
    }
    case "blob": {
      const type = headers["content-type"] ?? "";
      defineValue(xhr, "response", new Blob(bytes ? [bytes] : [], { type }));
      break;
    }
    default:
      defineValue(xhr, "responseText", text);
      defineValue(xhr, "response", text);
      break;
  }

  defineValue(xhr, "readyState", 4);

  dispatch(xhr, "loadstart");
  dispatch(xhr, "progress");
  dispatch(xhr, "readystatechange");
  dispatch(xhr, "load");
  dispatch(xhr, "loadend");
}

function dispatch(xhr: XMLHttpRequest, type: string): void {
  xhr.dispatchEvent(new Event(type));
}
