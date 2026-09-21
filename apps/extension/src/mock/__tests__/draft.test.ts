import { describe, expect, it } from "vitest";
import type { MockRule } from "@/transport/types";
import {
  draftFromRule,
  emptyDraft,
  formatHeaders,
  parseHeaderLines,
  ruleFromDraft,
  rulesFromJson,
} from "../draft";

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

describe("emptyDraft", () => {
  it("starts enabled with a 200 and no method filter", () => {
    const draft = emptyDraft();
    expect(draft.enabled).toBe(true);
    expect(draft.status).toBe("200");
    expect(draft.method).toBe("");
    expect(draft.delay).toBe("");
  });
});

describe("draftFromRule / ruleFromDraft round trip", () => {
  it("survives a round trip unchanged", () => {
    const original = rule({
      id: "m_1",
      enabled: false,
      method: "POST",
      status: 503,
      headers: [{ name: "content-type", value: "application/json" }],
      body: '{"error":"down"}',
      delay_ms: 250,
      note: "backend down",
    });
    const converted = ruleFromDraft(draftFromRule(original));
    expect("rule" in converted).toBe(true);
    if (!("rule" in converted)) return;
    expect(converted.rule).toEqual(original);
  });

  it("omits optional fields that the draft left blank", () => {
    const converted = ruleFromDraft({ ...emptyDraft(), url_pattern: "https://a.test/x" });
    expect("rule" in converted).toBe(true);
    if (!("rule" in converted)) return;
    expect(converted.rule.method).toBeUndefined();
    expect(converted.rule.delay_ms).toBeUndefined();
    expect(converted.rule.note).toBeUndefined();
  });

  it("mints an id when the draft has none", () => {
    const converted = ruleFromDraft({ ...emptyDraft(), url_pattern: "https://a.test/x" });
    expect("rule" in converted).toBe(true);
    if (!("rule" in converted)) return;
    expect(converted.rule.id).toMatch(/^m_/);
  });

  it("trims the url pattern and the note", () => {
    const converted = ruleFromDraft({
      ...emptyDraft(),
      url_pattern: "  https://a.test/x  ",
      note: "  hi  ",
    });
    expect("rule" in converted).toBe(true);
    if (!("rule" in converted)) return;
    expect(converted.rule.url_pattern).toBe("https://a.test/x");
    expect(converted.rule.note).toBe("hi");
  });
});

describe("ruleFromDraft validation", () => {
  it("rejects a blank url pattern", () => {
    const converted = ruleFromDraft(emptyDraft());
    expect("error" in converted).toBe(true);
    if (!("error" in converted)) return;
    expect(converted.error).toContain("url_pattern");
  });

  it("rejects a non-numeric status", () => {
    const converted = ruleFromDraft({
      ...emptyDraft(),
      url_pattern: "https://a.test/x",
      status: "abc",
    });
    expect("error" in converted).toBe(true);
  });

  it("rejects an out-of-range status", () => {
    for (const status of ["999", "100", "199"]) {
      const converted = ruleFromDraft({
        ...emptyDraft(),
        url_pattern: "https://a.test/x",
        status,
      });
      expect("error" in converted, `status ${status} should be rejected`).toBe(true);
      if (!("error" in converted)) return;
      // The floor is 200 because `Response` refuses anything lower, so 1xx is out
      // of range rather than merely unusual.
      expect(converted.error).toContain("200 and 599");
    }
  });

  it("rejects a negative delay", () => {
    const converted = ruleFromDraft({
      ...emptyDraft(),
      url_pattern: "https://a.test/x",
      delay: "-5",
    });
    expect("error" in converted).toBe(true);
    if (!("error" in converted)) return;
    expect(converted.error).toContain("delay");
  });

  it("treats a blank delay as no delay", () => {
    const converted = ruleFromDraft({
      ...emptyDraft(),
      url_pattern: "https://a.test/x",
      delay: "   ",
    });
    expect("rule" in converted).toBe(true);
    if (!("rule" in converted)) return;
    expect(converted.rule.delay_ms).toBeUndefined();
  });
});

describe("parseHeaderLines", () => {
  it("parses one header per line", () => {
    const parsed = parseHeaderLines("content-type: application/json\nx-trace: abc");
    expect(parsed).toEqual({
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-trace", value: "abc" },
      ],
    });
  });

  it("skips blank lines and a trailing newline", () => {
    const parsed = parseHeaderLines("a: 1\n\n\nb: 2\n");
    expect("headers" in parsed && parsed.headers).toHaveLength(2);
  });

  it("returns no headers for empty input", () => {
    expect(parseHeaderLines("")).toEqual({ headers: [] });
    expect(parseHeaderLines("   \n  ")).toEqual({ headers: [] });
  });

  it("splits on the first colon only", () => {
    const parsed = parseHeaderLines("x-forwarded-for: 1.2.3.4:5678");
    expect("headers" in parsed && parsed.headers[0]).toEqual({
      name: "x-forwarded-for",
      value: "1.2.3.4:5678",
    });
  });

  it("reports the line number of a header with no colon", () => {
    const parsed = parseHeaderLines("a: 1\nbroken");
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    expect(parsed.error).toContain("line 2");
  });

  it("rejects a header with an empty name", () => {
    const parsed = parseHeaderLines(": value");
    expect("error" in parsed).toBe(true);
  });
});

describe("formatHeaders", () => {
  it("renders the textarea form", () => {
    expect(
      formatHeaders([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).toBe("a: 1\nb: 2");
  });

  it("renders nothing for no headers", () => {
    expect(formatHeaders([])).toBe("");
  });
});

describe("rulesFromJson", () => {
  it("parses an exported array", () => {
    const text = JSON.stringify([
      { url_pattern: "https://a.test/x", status: 200, body: "1" },
      { url_pattern: "https://a.test/y", status: 404 },
    ]);
    const parsed = rulesFromJson(text);
    expect("rules" in parsed).toBe(true);
    if (!("rules" in parsed)) return;
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]?.id).toMatch(/^m_/);
  });

  it("keeps ids that are present so a round trip is stable", () => {
    const text = JSON.stringify([{ id: "m_keep", url_pattern: "https://a.test/x" }]);
    const parsed = rulesFromJson(text);
    expect("rules" in parsed).toBe(true);
    if (!("rules" in parsed)) return;
    expect(parsed.rules[0]?.id).toBe("m_keep");
  });

  it("reports invalid json", () => {
    const parsed = rulesFromJson("{not json");
    expect("error" in parsed).toBe(true);
  });

  it("rejects a non-array payload", () => {
    const parsed = rulesFromJson('{"url_pattern":"x"}');
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    expect(parsed.error).toContain("array");
  });

  it("names the offending entry", () => {
    const parsed = rulesFromJson(JSON.stringify([{ url_pattern: "https://a.test/x" }, {}]));
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    expect(parsed.error).toContain("entry #1");
  });
});
