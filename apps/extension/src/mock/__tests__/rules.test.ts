import { describe, expect, it } from "vitest";
import type { MockParams, MockRule } from "@/transport/types";
import {
  applyMockAction,
  MAX_DELAY_MS,
  MAX_RULES,
  MAX_URL_PATTERN_LEN,
  mintRuleId,
  normaliseRule,
  normaliseRules,
  validateRule,
  validateRuleSet,
} from "../rules";

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

function params(overrides: Partial<MockParams>): MockParams {
  return { session_id: "abcd", action: "list", ...overrides };
}

describe("mintRuleId", () => {
  it("produces distinct m_ prefixed ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintRuleId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^m_[0-9a-f]{8}$/);
  });
});

describe("normaliseRule", () => {
  it("fills every default for a minimal rule", () => {
    const normalised = normaliseRule({ url_pattern: "https://a.test/x" });
    expect(normalised).toEqual({
      enabled: true,
      url_pattern: "https://a.test/x",
      status: 200,
      headers: [],
      body: "",
      body_encoding: "text",
    });
  });

  it("rejects a rule with no usable url pattern", () => {
    expect(normaliseRule({})).toBeNull();
    expect(normaliseRule({ url_pattern: "" })).toBeNull();
    expect(normaliseRule({ url_pattern: "   " })).toBeNull();
    expect(normaliseRule(null)).toBeNull();
    expect(normaliseRule("nope")).toBeNull();
    expect(normaliseRule([])).toBeNull();
  });

  it("treats enabled false as off and anything else as on", () => {
    expect(normaliseRule({ url_pattern: "/x", enabled: false })?.enabled).toBe(false);
    expect(normaliseRule({ url_pattern: "/x", enabled: "no" })?.enabled).toBe(true);
  });

  it("upcases the method", () => {
    expect(normaliseRule({ url_pattern: "/x", method: "post" })?.method).toBe("POST");
  });

  it("drops headers that are not name/value strings", () => {
    const normalised = normaliseRule({
      url_pattern: "/x",
      headers: [{ name: "a", value: "1" }, { name: "b" }, "nope", null, { name: 1, value: 2 }],
    });
    expect(normalised?.headers).toEqual([{ name: "a", value: "1" }]);
  });

  it("only accepts the two known body encodings", () => {
    expect(normaliseRule({ url_pattern: "/x", body_encoding: "base64" })?.body_encoding).toBe(
      "base64",
    );
    expect(normaliseRule({ url_pattern: "/x", body_encoding: "hex" })?.body_encoding).toBe("text");
  });

  it("drops a non-finite delay", () => {
    expect(normaliseRule({ url_pattern: "/x", delay_ms: Number.NaN })?.delay_ms).toBeUndefined();
    expect(normaliseRule({ url_pattern: "/x", delay_ms: 100 })?.delay_ms).toBe(100);
  });
});

describe("normaliseRules", () => {
  it("keeps the good entries and drops the rest", () => {
    const rules = normaliseRules([
      { url_pattern: "https://a.test/1" },
      { nonsense: true },
      { url_pattern: "https://a.test/2" },
    ]);
    expect(rules.map((r) => r.url_pattern)).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("returns an empty list for a non-array", () => {
    expect(normaliseRules(undefined)).toEqual([]);
    expect(normaliseRules({})).toEqual([]);
  });
});

describe("validateRule", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRule(rule())).toBeNull();
  });

  it("rejects an empty url pattern", () => {
    expect(validateRule(rule({ url_pattern: " " }))).toContain("url_pattern");
  });

  it("rejects an over-long url pattern", () => {
    expect(validateRule(rule({ url_pattern: "a".repeat(MAX_URL_PATTERN_LEN + 1) }))).toContain(
      "limit",
    );
  });

  it("rejects a method that is not ASCII letters", () => {
    expect(validateRule(rule({ method: "G3T" }))).toContain("ASCII letters");
    expect(validateRule(rule({ method: "" }))).toContain("valid HTTP method");
    expect(validateRule(rule({ method: "get" }))).toBeNull();
  });

  it("rejects an out-of-range status", () => {
    // 1xx is rejected along with everything below 200: `Response` cannot
    // represent it, so accepting it would save a rule that throws in the page.
    for (const status of [0, 99, 100, 101, 199, 600, 999]) {
      expect(validateRule(rule({ status }))).toContain("status");
    }
    for (const status of [200, 204, 302, 404, 599]) {
      expect(validateRule(rule({ status }))).toBeNull();
    }
  });

  it("rejects a header that would allow injection", () => {
    expect(
      validateRule(rule({ headers: [{ name: "x", value: "a\r\nSet-Cookie: pwned=1" }] })),
    ).toContain("line break");
  });

  it("rejects an empty header name", () => {
    expect(validateRule(rule({ headers: [{ name: "  ", value: "v" }] }))).toContain("header name");
  });

  it("rejects an over-long delay", () => {
    expect(validateRule(rule({ delay_ms: MAX_DELAY_MS + 1 }))).toContain("delay_ms");
    expect(validateRule(rule({ delay_ms: MAX_DELAY_MS }))).toBeNull();
  });

  it("rejects a negative delay", () => {
    expect(validateRule(rule({ delay_ms: -1 }))).toContain("non-negative");
  });
});

describe("validateRuleSet", () => {
  it("names the offending index", () => {
    expect(validateRuleSet([rule(), rule({ url_pattern: "" })])).toMatch(/^rule #1:/);
  });

  it("caps the set size", () => {
    const rules = Array.from({ length: MAX_RULES }, () => rule());
    expect(validateRuleSet(rules)).toBeNull();
    expect(validateRuleSet([...rules, rule()])).toContain(String(MAX_RULES));
  });
});

describe("applyMockAction", () => {
  it("list returns a copy and changes nothing", () => {
    const current = [rule({ id: "m_1" })];
    const outcome = applyMockAction(current, params({ action: "list" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rules).toEqual(current);
    expect(outcome.rules).not.toBe(current);
    expect(outcome.createdId).toBeUndefined();
    expect(outcome.removed).toBeUndefined();
  });

  it("add mints an id and appends so rule order matches the page", () => {
    const current = [rule({ id: "m_1" })];
    const outcome = applyMockAction(
      current,
      params({ action: "add", rule: rule({ url_pattern: "https://b.test/x" }) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rules).toHaveLength(2);
    expect(outcome.rules[1]?.url_pattern).toBe("https://b.test/x");
    expect(outcome.createdId).toMatch(/^m_/);
    expect(outcome.rules[1]?.id).toBe(outcome.createdId);
  });

  it("add keeps a caller-supplied id", () => {
    const outcome = applyMockAction([], params({ action: "add", rule: rule({ id: "m_fixed" }) }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdId).toBe("m_fixed");
  });

  it("add refuses a malformed rule", () => {
    const outcome = applyMockAction([], params({ action: "add", rule: rule({ status: 999 }) }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("status");
  });

  it("add refuses without a rule", () => {
    const outcome = applyMockAction([], params({ action: "add" }));
    expect(outcome.ok).toBe(false);
  });

  it("add refuses past the rule cap", () => {
    const full = Array.from({ length: MAX_RULES }, (_, index) => rule({ id: `m_${index}` }));
    const outcome = applyMockAction(full, params({ action: "add", rule: rule() }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain(String(MAX_RULES));
  });

  it("remove deletes the named rule", () => {
    const current = [rule({ id: "m_1" }), rule({ id: "m_2" })];
    const outcome = applyMockAction(current, params({ action: "remove", id: "m_1" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rules.map((r) => r.id)).toEqual(["m_2"]);
    expect(outcome.removed).toBe(1);
  });

  it("remove of an unknown id is an error, not a silent no-op", () => {
    const outcome = applyMockAction(
      [rule({ id: "m_1" })],
      params({ action: "remove", id: "m_nope" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("m_nope");
  });

  it("remove refuses without an id", () => {
    expect(applyMockAction([rule()], params({ action: "remove" })).ok).toBe(false);
  });

  it("clear empties the table and reports how many went", () => {
    const outcome = applyMockAction(
      [rule({ id: "m_1" }), rule({ id: "m_2" })],
      params({ action: "clear" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rules).toEqual([]);
    expect(outcome.removed).toBe(2);
  });

  it("clear on an empty table is fine", () => {
    const outcome = applyMockAction([], params({ action: "clear" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.removed).toBe(0);
  });

  it("replace_all mints ids for entries that lack one", () => {
    const outcome = applyMockAction(
      [],
      params({ action: "replace_all", rules: [rule(), rule({ id: "m_keep" })] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rules[0]?.id).toMatch(/^m_/);
    expect(outcome.rules[1]?.id).toBe("m_keep");
  });

  it("replace_all validates the whole set before touching anything", () => {
    const outcome = applyMockAction(
      [rule({ id: "m_1" })],
      params({ action: "replace_all", rules: [rule(), rule({ url_pattern: "" })] }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("rule #1");
  });

  it("replace_all refuses without rules", () => {
    expect(applyMockAction([], params({ action: "replace_all" })).ok).toBe(false);
  });
});
