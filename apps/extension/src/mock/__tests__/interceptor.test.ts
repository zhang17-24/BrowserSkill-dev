import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockRule } from "@/transport/types";
import {
  absoluteUrl,
  describeFetchRequest,
  installMockInterceptor,
  type MockTarget,
} from "../interceptor";

function rule(overrides: Partial<MockRule> = {}): MockRule {
  return {
    enabled: true,
    url_pattern: "https://api.example.com/user/*",
    status: 200,
    headers: [],
    body: "",
    body_encoding: "text",
    ...overrides,
  };
}

/**
 * A stand-in for `XMLHttpRequest`.
 *
 * Deliberately not the real one: the assertion that matters is "the real
 * `send` was never called", and a fake records that directly instead of
 * inferring it from whether a network request appeared.
 */
class FakeXhr extends EventTarget {
  static sent: Array<{ url: string; method: string; body: unknown }> = [];

  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  response: unknown = "";
  responseType = "";
  responseURL = "";

  open(method: string, url: string, _async?: boolean): void {
    this.readyState = 1;
    this.responseURL = url;
  }

  send(body?: unknown): void {
    FakeXhr.sent.push({
      url: this.responseURL,
      method: "GET",
      body,
    });
  }

  getAllResponseHeaders(): string {
    return "";
  }

  getResponseHeader(_name: string): string | null {
    return null;
  }
}

const installed: Array<() => void> = [];

function makeTarget(baseUrl = "https://app.test/"): MockTarget & {
  realFetch: ReturnType<typeof vi.fn>;
} {
  const realFetch = vi.fn(async () => new Response("real", { status: 200 }));
  return {
    fetch: realFetch as unknown as typeof globalThis.fetch,
    XMLHttpRequest: FakeXhr as unknown as typeof globalThis.XMLHttpRequest,
    getBaseUrl: () => baseUrl,
    realFetch,
  };
}

function install(target: MockTarget, rules: MockRule[], sleep = vi.fn(async () => {})) {
  const uninstall = installMockInterceptor(target, {
    getRules: () => rules,
    sleep,
  });
  installed.push(uninstall);
  return { uninstall, sleep };
}

afterEach(() => {
  while (installed.length > 0) installed.pop()?.();
  FakeXhr.sent = [];
  vi.restoreAllMocks();
});

describe("absoluteUrl", () => {
  it("resolves a relative path against the page url", () => {
    expect(absoluteUrl("/api/user/1", "https://app.test/dashboard")).toBe(
      "https://app.test/api/user/1",
    );
  });

  it("leaves an absolute url alone", () => {
    expect(absoluteUrl("https://api.example.com/user/1", "https://app.test/")).toBe(
      "https://api.example.com/user/1",
    );
  });

  it("returns the raw input when it cannot be parsed", () => {
    expect(absoluteUrl("::not a url::", "not-a-base-either")).toBe("::not a url::");
  });
});

describe("describeFetchRequest", () => {
  it("reads a string input and defaults the method to GET", () => {
    expect(describeFetchRequest("/api/user/1", undefined, "https://app.test/")).toEqual({
      url: "https://app.test/api/user/1",
      method: "GET",
    });
  });

  it("upcases the method from init", () => {
    expect(
      describeFetchRequest("/api/user/1", { method: "post" }, "https://app.test/").method,
    ).toBe("POST");
  });

  it("reads a URL object", () => {
    expect(
      describeFetchRequest(new URL("https://api.example.com/user/1"), undefined, "https://app.test/")
        .url,
    ).toBe("https://api.example.com/user/1");
  });

  it("reads a Request and lets init override the method", () => {
    const request = new Request("https://api.example.com/user/1", { method: "PUT" });
    expect(describeFetchRequest(request, undefined, "https://app.test/").method).toBe("PUT");
    expect(describeFetchRequest(request, { method: "delete" }, "https://app.test/").method).toBe(
      "DELETE",
    );
  });
});

describe("fetch interception", () => {
  it("answers a matched request without touching the network", async () => {
    const target = makeTarget();
    install(target, [rule({ body: "火狐" })]);

    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("火狐");
  });

  it("passes an unmatched request straight through", async () => {
    const target = makeTarget();
    install(target, [rule()]);

    const response = await target.fetch("https://other.test/thing");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("real");
  });

  it("passes through when there are no rules at all", async () => {
    const target = makeTarget();
    install(target, []);

    await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });

  it("matches a relative request against the page url", async () => {
    const target = makeTarget("https://api.example.com/");
    install(target, [rule({ body: "mocked" })]);

    const response = await target.fetch("/user/1");

    expect(target.realFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("mocked");
  });

  it("honours the method filter", async () => {
    const target = makeTarget();
    install(target, [rule({ method: "GET" })]);

    await target.fetch("https://api.example.com/user/1", { method: "POST" });

    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });

  it("applies the rule's status and headers", async () => {
    const target = makeTarget();
    install(target, [
      rule({ status: 503, body: "down", headers: [{ name: "retry-after", value: "30" }] }),
    ]);

    const response = await target.fetch("https://api.example.com/user/1");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("waits out delay_ms before resolving", async () => {
    const target = makeTarget();
    const sleep = vi.fn(async () => {});
    install(target, [rule({ delay_ms: 300 })], sleep);

    await target.fetch("https://api.example.com/user/1");

    expect(sleep).toHaveBeenCalledWith(300);
  });

  it("does not sleep when the rule has no delay", async () => {
    const target = makeTarget();
    const sleep = vi.fn(async () => {});
    install(target, [rule()], sleep);

    await target.fetch("https://api.example.com/user/1");

    expect(sleep).not.toHaveBeenCalled();
  });

  it("still mocks the first request when the rule set arrives late", async () => {
    // The rule set is read from storage asynchronously and may land after the
    // page has already started issuing requests. Awaiting it per request is
    // what stops that first request from escaping un-mocked.
    const target = makeTarget();
    let release: ((rules: MockRule[]) => void) | undefined;
    const pending = new Promise<MockRule[]>((resolve) => {
      release = resolve;
    });
    installed.push(
      installMockInterceptor(target, { getRules: () => pending, sleep: async () => {} }),
    );

    const inFlight = target.fetch("https://api.example.com/user/1");
    release?.([rule({ body: "late" })]);
    const response = await inFlight;

    expect(target.realFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("late");
  });

  it("re-reads the rules on every request so a live edit takes effect", async () => {
    const target = makeTarget();
    let rules: MockRule[] = [];
    installed.push(
      installMockInterceptor(target, { getRules: () => rules, sleep: async () => {} }),
    );

    await target.fetch("https://api.example.com/user/1");
    expect(target.realFetch).toHaveBeenCalledTimes(1);

    rules = [rule({ body: "now mocked" })];
    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("now mocked");
  });

  it("passes through when reading the rules throws", async () => {
    const target = makeTarget();
    installed.push(
      installMockInterceptor(target, {
        getRules: () => {
          throw new Error("storage exploded");
        },
        sleep: async () => {},
      }),
    );

    await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });

  it("passes through when the rule read rejects", async () => {
    // The realistic shape of a storage failure: an async read that rejects.
    // Failing open matters — rejecting here would surface a storage hiccup as
    // an application error the user cannot diagnose.
    const target = makeTarget();
    installed.push(
      installMockInterceptor(target, {
        getRules: () => Promise.reject(new Error("storage exploded")),
        sleep: async () => {},
      }),
    );

    await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: installing twice does not stack patches", async () => {
    const target = makeTarget();
    const sleep = vi.fn(async () => {});
    install(target, [rule({ delay_ms: 10 })], sleep);
    install(target, [rule({ delay_ms: 10 })], sleep);

    await target.fetch("https://api.example.com/user/1");

    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("restores the original fetch on uninstall", async () => {
    const target = makeTarget();
    const original = target.fetch;
    const { uninstall } = install(target, [rule({ body: "mocked" })]);
    expect(target.fetch).not.toBe(original);

    uninstall();

    expect(target.fetch).toBe(original);
    await target.fetch("https://api.example.com/user/1");
    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });
});

describe("XMLHttpRequest interception", () => {
  it("answers a matched request without calling the real send", async () => {
    const target = makeTarget();
    install(target, [rule({ body: '{"id":1}' })]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(xhr.readyState).toBe(4));

    expect(FakeXhr.sent).toHaveLength(0);
    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe('{"id":1}');
  });

  it("passes an unmatched request to the real send", async () => {
    const target = makeTarget();
    install(target, [rule()]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("GET", "https://other.test/thing");
    xhr.send();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));

    expect(FakeXhr.sent[0]?.url).toBe("https://other.test/thing");
  });

  it("resolves a relative url against the page url", async () => {
    const target = makeTarget("https://api.example.com/");
    install(target, [rule({ body: "mocked" })]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("GET", "/user/1");
    xhr.send();
    await vi.waitFor(() => expect(xhr.readyState).toBe(4));

    expect(FakeXhr.sent).toHaveLength(0);
    expect(xhr.responseText).toBe("mocked");
  });

  it("fires readystatechange, load and loadend", async () => {
    const target = makeTarget();
    install(target, [rule({ body: "ok" })]);

    const seen: string[] = [];
    const xhr = new target.XMLHttpRequest();
    for (const type of ["loadstart", "progress", "readystatechange", "load", "loadend"]) {
      xhr.addEventListener(type, () => seen.push(type));
    }
    xhr.open("GET", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(seen).toContain("loadend"));

    expect(seen).toEqual(["loadstart", "progress", "readystatechange", "load", "loadend"]);
  });

  it("exposes the rule's headers through the XHR header accessors", async () => {
    const target = makeTarget();
    install(target, [
      rule({
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-trace", value: "abc" },
        ],
      }),
    ]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(xhr.readyState).toBe(4));

    expect(xhr.getResponseHeader("x-trace")).toBe("abc");
    expect(xhr.getResponseHeader("X-Trace")).toBe("abc");
    expect(xhr.getResponseHeader("missing")).toBeNull();
    expect(xhr.getAllResponseHeaders()).toContain("x-trace: abc");
  });

  it("parses the body for responseType json", async () => {
    const target = makeTarget();
    install(target, [rule({ body: '{"id":1}' })]);

    const xhr = new target.XMLHttpRequest();
    xhr.responseType = "json";
    xhr.open("GET", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(xhr.readyState).toBe(4));

    expect(xhr.response).toEqual({ id: 1 });
  });

  it("yields null for responseType json when the body is not json", async () => {
    const target = makeTarget();
    install(target, [rule({ body: "not json" })]);

    const xhr = new target.XMLHttpRequest();
    xhr.responseType = "json";
    xhr.open("GET", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(xhr.readyState).toBe(4));

    expect(xhr.response).toBeNull();
  });

  it("honours the method filter", async () => {
    const target = makeTarget();
    install(target, [rule({ method: "GET" })]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("POST", "https://api.example.com/user/1");
    xhr.send();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
  });

  it("leaves a synchronous request on the real path", async () => {
    // Sync XHR cannot be deferred behind an await, so it must not be mocked
    // rather than silently hanging.
    const target = makeTarget();
    install(target, [rule({ body: "mocked" })]);

    const xhr = new target.XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/user/1", false);
    xhr.send();

    expect(FakeXhr.sent).toHaveLength(1);
  });
});
