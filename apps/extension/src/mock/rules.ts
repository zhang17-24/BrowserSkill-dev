import type {
  MockAction,
  MockBodyEncoding,
  MockHeader,
  MockParams,
  MockRule,
} from "@/transport/types";

/**
 * Rule normalisation, validation and the CRUD reducer.
 *
 * All pure: the reducer takes the current rule set and a request and returns
 * the next rule set, so "what does `add` actually do to the table" is testable
 * without a browser, a daemon or a storage area.
 *
 * The limits mirror `crates/bsk-protocol/src/tools/mock.rs`. They are
 * duplicated rather than shared because the CLI and the extension are
 * different languages; the extension re-checks so a rule that bypassed the
 * CLI (a hand-edited storage entry, a future non-CLI caller) still cannot
 * wedge the interceptor.
 */

export const MAX_URL_PATTERN_LEN = 2048;
export const MAX_BODY_LEN = 8 * 1024 * 1024;
export const MAX_DELAY_MS = 600_000;
export const MAX_RULES = 200;
export const MAX_HEADER_LEN = 8192;
export const MAX_NOTE_LEN = 512;

/** Storage key holding the rule array. */
export const MOCK_RULES_STORAGE_KEY = "bsk_mock_rules";

/** The scope note echoed on every `tool.mock` result. */
export const MOCK_SCOPE_NOTE =
  "rules apply to every tab in this browser profile and outlive the session";

/** Mint a rule id. Short and hex, so it is easy to retype into `bsk mock rm`. */
export function mintRuleId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return `m_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseHeaders(raw: unknown): MockHeader[] {
  if (!Array.isArray(raw)) return [];
  const headers: MockHeader[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.value !== "string") continue;
    headers.push({ name: entry.name, value: entry.value });
  }
  return headers;
}

/**
 * Coerce stored or wire data into a rule, or reject it.
 *
 * Returns `null` rather than throwing so a single corrupt entry in storage
 * cannot take down the interceptor for every page.
 */
export function normaliseRule(raw: unknown): MockRule | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.url_pattern !== "string" || raw.url_pattern.trim() === "") return null;

  const status = typeof raw.status === "number" ? raw.status : 200;
  const encoding: MockBodyEncoding = raw.body_encoding === "base64" ? "base64" : "text";
  const rule: MockRule = {
    enabled: raw.enabled !== false,
    url_pattern: raw.url_pattern,
    status,
    headers: normaliseHeaders(raw.headers),
    body: typeof raw.body === "string" ? raw.body : "",
    body_encoding: encoding,
  };

  if (typeof raw.id === "string" && raw.id !== "") rule.id = raw.id;
  if (typeof raw.method === "string" && raw.method !== "") {
    rule.method = raw.method.toUpperCase();
  }
  if (typeof raw.delay_ms === "number" && Number.isFinite(raw.delay_ms)) {
    rule.delay_ms = raw.delay_ms;
  }
  if (typeof raw.note === "string" && raw.note !== "") rule.note = raw.note;

  return rule;
}

/** Normalise an array, dropping entries that cannot be salvaged. */
export function normaliseRules(raw: unknown): MockRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: MockRule[] = [];
  for (const entry of raw) {
    const rule = normaliseRule(entry);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Validate a rule, returning a human-readable reason or `null`.
 *
 * The messages are written for an agent to act on, so they name the offending
 * field and the limit it broke.
 */
export function validateRule(rule: MockRule): string | null {
  if (rule.url_pattern.trim() === "") return "url_pattern must not be empty";
  if (rule.url_pattern.length > MAX_URL_PATTERN_LEN) {
    return `url_pattern is ${rule.url_pattern.length} bytes, over the ${MAX_URL_PATTERN_LEN} byte limit`;
  }
  if (rule.method !== undefined) {
    if (rule.method.length === 0 || rule.method.length > 16) {
      return `method ${JSON.stringify(rule.method)} is not a valid HTTP method`;
    }
    if (!/^[A-Za-z]+$/.test(rule.method)) {
      return `method ${JSON.stringify(rule.method)} must be ASCII letters (e.g. GET, POST)`;
    }
  }
  // The floor is 200, matching the `Response` constructor the interceptor uses:
  // it rejects anything outside 200..599 with a `RangeError`, so a 1xx rule would
  // pass validation and then fail inside the page as an error nobody can trace
  // back to the rule. Mirrors `validate_rule` in the Rust protocol crate.
  if (!Number.isInteger(rule.status) || rule.status < 200 || rule.status > 599) {
    return `status ${rule.status} out of range (200..=599)`;
  }
  if (rule.body.length > MAX_BODY_LEN) {
    return `body is ${rule.body.length} bytes, over the ${MAX_BODY_LEN} byte limit`;
  }
  if (rule.delay_ms !== undefined) {
    if (!Number.isFinite(rule.delay_ms) || rule.delay_ms < 0) {
      return `delay_ms ${rule.delay_ms} must be a non-negative number`;
    }
    if (rule.delay_ms > MAX_DELAY_MS) {
      return `delay_ms ${rule.delay_ms} over the ${MAX_DELAY_MS} ms limit`;
    }
  }
  if (rule.note !== undefined && rule.note.length > MAX_NOTE_LEN) {
    return `note is ${rule.note.length} bytes, over the ${MAX_NOTE_LEN} byte limit`;
  }
  for (const header of rule.headers) {
    if (header.name.trim() === "") return "header name must not be empty";
    if (header.name.length > MAX_HEADER_LEN || header.value.length > MAX_HEADER_LEN) {
      return `header ${JSON.stringify(header.name)} exceeds the ${MAX_HEADER_LEN} byte limit`;
    }
    if (/[\r\n]/.test(header.name) || /[\r\n]/.test(header.value)) {
      return `header ${JSON.stringify(header.name)} contains a line break, which would allow header injection`;
    }
  }
  return null;
}

/** Validate a whole set, naming the offending index. */
export function validateRuleSet(rules: readonly MockRule[]): string | null {
  if (rules.length > MAX_RULES) {
    return `${rules.length} rules exceeds the ${MAX_RULES} rule limit`;
  }
  for (let index = 0; index < rules.length; index += 1) {
    const reason = validateRule(rules[index] as MockRule);
    if (reason) return `rule #${index}: ${reason}`;
  }
  return null;
}

/** The next rule set after an action, or the reason it was refused. */
export type MockActionOutcome =
  | { ok: true; rules: MockRule[]; createdId?: string; removed?: number }
  | { ok: false; message: string };

/**
 * Apply a `tool.mock` action to the current rule set.
 *
 * New rules go on the end, so rule order — and therefore which rule wins for
 * an overlapping URL — matches the order shown on the rules page.
 */
export function applyMockAction(
  current: readonly MockRule[],
  params: MockParams,
): MockActionOutcome {
  switch (params.action) {
    case "list":
      return { ok: true, rules: [...current] };

    case "add": {
      if (!params.rule) return { ok: false, message: "add requires a rule" };
      if (current.length >= MAX_RULES) {
        return { ok: false, message: `cannot exceed ${MAX_RULES} rules` };
      }
      const rule = normaliseRule(params.rule);
      if (!rule) {
        return { ok: false, message: "rule is malformed: url_pattern must be a non-empty string" };
      }
      const id = rule.id ?? mintRuleId();
      const created: MockRule = { ...rule, id };
      const reason = validateRule(created);
      if (reason) return { ok: false, message: reason };
      return { ok: true, rules: [...current, created], createdId: id };
    }

    case "remove": {
      if (!params.id) return { ok: false, message: "remove requires an id" };
      const next = current.filter((rule) => rule.id !== params.id);
      if (next.length === current.length) {
        return { ok: false, message: `no rule with id ${JSON.stringify(params.id)}` };
      }
      return { ok: true, rules: next, removed: 1 };
    }

    case "move": {
      // Position is precedence, and `add` appends — so without this a rule added
      // after a broader one can never fire, silently, because the broad rule that
      // answers everything looks like it is working.
      if (!params.id) return { ok: false, message: "move requires an id" };
      const from = current.findIndex((rule) => rule.id === params.id);
      if (from === -1) {
        return { ok: false, message: `no rule with id ${JSON.stringify(params.id)}` };
      }
      const to = params.to;
      if (to === undefined || !Number.isInteger(to) || to < 0 || to >= current.length) {
        // Refused rather than clamped: "moved it to the end" and "it was already
        // at the end" are different answers, and a silent clamp hides a caller
        // working from a stale list.
        return {
          ok: false,
          message: `move needs a position between 0 and ${current.length - 1} for ${current.length} rule(s)`,
        };
      }
      if (from === to) return { ok: true, rules: [...current] };

      const next = [...current];
      const [moved] = next.splice(from, 1);
      // `from` was found in `current`, so the splice always produced one element.
      next.splice(to, 0, moved as MockRule);
      return { ok: true, rules: next };
    }

    case "clear":
      return { ok: true, rules: [], removed: current.length };

    case "replace_all": {
      if (!params.rules) return { ok: false, message: "replace_all requires rules" };
      const normalised: MockRule[] = [];
      // The index is named so a bad entry in an imported file can be found
      // without bisecting the list by hand.
      for (let index = 0; index < params.rules.length; index += 1) {
        const rule = normaliseRule(params.rules[index]);
        if (!rule) {
          return {
            ok: false,
            message: `rule #${index} is malformed: url_pattern must be a non-empty string`,
          };
        }
        normalised.push({ ...rule, id: rule.id ?? mintRuleId() });
      }
      const reason = validateRuleSet(normalised);
      if (reason) return { ok: false, message: reason };
      return { ok: true, rules: normalised, removed: current.length };
    }

    default: {
      const exhaustive: never = params.action;
      return { ok: false, message: `unknown action ${String(exhaustive)}` };
    }
  }
}

/** Narrowing helper so callers can switch on the action without casts. */
export function isKnownAction(value: unknown): value is MockAction {
  return (
    value === "add" ||
    value === "list" ||
    value === "remove" ||
    value === "clear" ||
    value === "replace_all" ||
    value === "move"
  );
}
