import type { MockBodyEncoding, MockHeader, MockRule } from "@/transport/types";
import { mintRuleId, normaliseRule, validateRule } from "./rules";

/**
 * The bridge between the rules page's form controls and the wire shape.
 *
 * Controls are all strings — a `<input>` has no opinion about whether the
 * status is a number or the body is JSON — so the conversions in and out are
 * where the interesting mistakes live. Keeping them here rather than in the
 * component makes them testable without rendering anything.
 */

export interface RuleDraft {
  id?: string;
  enabled: boolean;
  url_pattern: string;
  /** Empty string means "any method". */
  method: string;
  /** Kept as a string so the field can be mid-edit and empty. */
  status: string;
  /** One `Name: value` per line. */
  headers: string;
  body: string;
  body_encoding: MockBodyEncoding;
  /** Kept as a string so the field can be mid-edit and empty. */
  delay: string;
  note: string;
}

export function emptyDraft(): RuleDraft {
  return {
    enabled: true,
    url_pattern: "",
    method: "",
    status: "200",
    headers: "",
    body: "",
    body_encoding: "text",
    delay: "",
    note: "",
  };
}

export function draftFromRule(rule: MockRule): RuleDraft {
  return {
    id: rule.id,
    enabled: rule.enabled,
    url_pattern: rule.url_pattern,
    method: rule.method ?? "",
    status: String(rule.status),
    headers: formatHeaders(rule.headers),
    body: rule.body,
    body_encoding: rule.body_encoding,
    delay: rule.delay_ms === undefined ? "" : String(rule.delay_ms),
    note: rule.note ?? "",
  };
}

/** Render headers as the textarea's `Name: value` lines. */
export function formatHeaders(headers: readonly MockHeader[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

/**
 * Parse the headers textarea.
 *
 * Blank lines are skipped so a trailing newline is not an error. A line with
 * no colon is rejected rather than guessed at — silently dropping a header
 * the user typed would make the mock look broken for no visible reason.
 */
export function parseHeaderLines(text: string): { headers: MockHeader[] } | { error: string } {
  const headers: MockHeader[] = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) {
      return { error: `header line ${index + 1} needs a colon, as Name: value` };
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name === "") {
      return { error: `header line ${index + 1} has an empty name` };
    }
    headers.push({ name, value });
  }

  return { headers };
}

/** Convert a draft into a rule, or explain what is wrong with it. */
export function ruleFromDraft(draft: RuleDraft): { rule: MockRule } | { error: string } {
  const status = Number(draft.status.trim());
  // 200..599, not 100..599: `Response` refuses a status below 200, so a 1xx rule
  // would save and then throw inside the page.
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return { error: `status ${JSON.stringify(draft.status)} must be between 200 and 599` };
  }

  const parsedHeaders = parseHeaderLines(draft.headers);
  if ("error" in parsedHeaders) return { error: parsedHeaders.error };

  const delayText = draft.delay.trim();
  let delayMs: number | undefined;
  if (delayText !== "") {
    const parsed = Number(delayText);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: `delay ${JSON.stringify(draft.delay)} must be a non-negative number` };
    }
    delayMs = parsed;
  }

  const rule: MockRule = {
    id: draft.id ?? mintRuleId(),
    enabled: draft.enabled,
    url_pattern: draft.url_pattern.trim(),
    status,
    headers: parsedHeaders.headers,
    body: draft.body,
    body_encoding: draft.body_encoding,
  };
  const method = draft.method.trim();
  if (method !== "") rule.method = method.toUpperCase();
  if (delayMs !== undefined) rule.delay_ms = delayMs;
  const note = draft.note.trim();
  if (note !== "") rule.note = note;

  // Reuse the same validation the RPC path uses, so the page cannot save
  // something `bsk mock add` would refuse.
  const reason = validateRule(rule);
  if (reason) return { error: reason };

  return { rule };
}

/** Parse an exported JSON array back into rules. */
export function rulesFromJson(text: string): { rules: MockRule[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!Array.isArray(parsed)) return { error: "expected a JSON array of rules" };

  const rules: MockRule[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const rule = normaliseRule(parsed[index]);
    if (!rule) {
      return { error: `entry #${index} is not a usable rule (url_pattern is required)` };
    }
    const reason = validateRule(rule);
    if (reason) return { error: `entry #${index}: ${reason}` };
    rules.push({ ...rule, id: rule.id ?? mintRuleId() });
  }
  return { rules };
}
