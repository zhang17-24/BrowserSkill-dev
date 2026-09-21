import { beforeEach, describe, expect, it } from "vitest";
import type { MockRule } from "@/transport/types";
import { findMatchingRule, globToRegExp, matchesRule, resetPatternCache } from "../matcher";

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

describe("globToRegExp", () => {
  beforeEach(() => {
    resetPatternCache();
  });

  it("anchors the pattern to the whole url", () => {
    expect(globToRegExp("https://a.test/x").test("https://a.test/x")).toBe(true);
    expect(globToRegExp("https://a.test/x").test("https://a.test/xy")).toBe(false);
    expect(globToRegExp("https://a.test/x").test("https://a.test/prefix-x")).toBe(false);
  });

  it("treats a literal dot as a dot, not as any character", () => {
    expect(globToRegExp("https://a.test/x").test("https://aXtest/x")).toBe(false);
  });

  it("escapes every regex metacharacter it does not own", () => {
    const pattern = "https://a.test/x?a=1&b=2+3";
    expect(globToRegExp(pattern).test(pattern)).toBe(true);
    expect(globToRegExp(pattern).test("https://aXtest/x?a=1&b=2+3")).toBe(false);
  });

  it("treats brackets and parentheses as literals", () => {
    const pattern = "https://a.test/a(1)[2]";
    expect(globToRegExp(pattern).test(pattern)).toBe(true);
  });

  it("lets a star cross path separators", () => {
    // A rule for a collection must also cover the nested resources under it,
    // which is the whole reason `*` cannot stop at `/`.
    const pattern = "https://api.example.com/api/user/*";
    expect(globToRegExp(pattern).test("https://api.example.com/api/user/42")).toBe(true);
    expect(globToRegExp(pattern).test("https://api.example.com/api/user/42/posts")).toBe(true);
  });

  it("lets a star match the empty string", () => {
    const pattern = "https://a.test/x*";
    expect(globToRegExp(pattern).test("https://a.test/x")).toBe(true);
  });

  it("matches a question mark against exactly one character", () => {
    const pattern = "https://a.test/v?";
    expect(globToRegExp(pattern).test("https://a.test/v1")).toBe(true);
    expect(globToRegExp(pattern).test("https://a.test/v")).toBe(false);
    expect(globToRegExp(pattern).test("https://a.test/v12")).toBe(false);
  });

  it("supports a leading wildcard so the scheme can be omitted", () => {
    const pattern = "*/api/user/*";
    expect(globToRegExp(pattern).test("https://api.example.com/api/user/1")).toBe(true);
    expect(globToRegExp(pattern).test("http://localhost:3000/api/user/1")).toBe(true);
  });

  it("matches the query string as part of the url", () => {
    const pattern = "https://a.test/search?q=*";
    expect(globToRegExp(pattern).test("https://a.test/search?q=firefox")).toBe(true);
    expect(globToRegExp(pattern).test("https://a.test/search")).toBe(false);
  });

  it("is case-sensitive", () => {
    const pattern = "https://a.test/User/*";
    expect(globToRegExp(pattern).test("https://a.test/User/1")).toBe(true);
    expect(globToRegExp(pattern).test("https://a.test/user/1")).toBe(false);
  });

  it("returns the same instance for a repeated pattern", () => {
    const first = globToRegExp("https://a.test/x");
    expect(globToRegExp("https://a.test/x")).toBe(first);
  });

  it("stops caching once the limit is reached", () => {
    for (let index = 0; index < 300; index += 1) {
      globToRegExp(`https://a.test/p${index}`);
    }
    // Still correct after eviction — the cache must not change behaviour.
    expect(globToRegExp("https://a.test/x").test("https://a.test/x")).toBe(true);
  });
});

describe("matchesRule", () => {
  it("matches on the url pattern alone when no method is set", () => {
    expect(matchesRule(rule(), "https://api.example.com/user/1", "GET")).toBe(true);
    expect(matchesRule(rule(), "https://api.example.com/user/1", "DELETE")).toBe(true);
  });

  it("rejects a url that does not match", () => {
    expect(matchesRule(rule(), "https://other.test/user/1", "GET")).toBe(false);
  });

  it("never matches a disabled rule", () => {
    expect(matchesRule(rule({ enabled: false }), "https://api.example.com/user/1", "GET")).toBe(
      false,
    );
  });

  it("compares the method case-insensitively", () => {
    const withMethod = rule({ method: "POST" });
    expect(matchesRule(withMethod, "https://api.example.com/user/1", "post")).toBe(true);
    expect(matchesRule(withMethod, "https://api.example.com/user/1", "POST")).toBe(true);
  });

  it("rejects a different method", () => {
    const withMethod = rule({ method: "GET" });
    expect(matchesRule(withMethod, "https://api.example.com/user/1", "POST")).toBe(false);
  });
});

describe("findMatchingRule", () => {
  it("returns null when nothing matches", () => {
    expect(findMatchingRule([rule()], "https://other.test/x", "GET")).toBeNull();
  });

  it("returns null for an empty rule set", () => {
    expect(findMatchingRule([], "https://api.example.com/user/1", "GET")).toBeNull();
  });

  it("lets the first match win so rule order on the page is the truth", () => {
    const broad = rule({ id: "broad", url_pattern: "https://api.example.com/*", body: "broad" });
    const narrow = rule({
      id: "narrow",
      url_pattern: "https://api.example.com/user/*",
      body: "narrow",
    });

    expect(findMatchingRule([broad, narrow], "https://api.example.com/user/1", "GET")?.id).toBe(
      "broad",
    );
    expect(findMatchingRule([narrow, broad], "https://api.example.com/user/1", "GET")?.id).toBe(
      "narrow",
    );
  });

  it("skips a disabled rule in favour of a later enabled one", () => {
    const off = rule({ id: "off", enabled: false });
    const on = rule({ id: "on", url_pattern: "https://api.example.com/user/*" });
    expect(findMatchingRule([off, on], "https://api.example.com/user/1", "GET")?.id).toBe("on");
  });
});
