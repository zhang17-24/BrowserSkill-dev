import type { MockRule } from "@/transport/types";

/**
 * Turn a mock rule into the response the page receives.
 *
 * Separate from the interceptor so the fiddly parts — base64 bodies, statuses
 * that may not carry a body, content-type inference — are testable without
 * patching any global.
 */

/**
 * Statuses where the Fetch spec forbids a body. Handing `Response` a body for
 * one of these throws a TypeError, which would surface as an unrelated page
 * error rather than "your rule is wrong", so they are filtered here.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function isNullBodyStatus(status: number): boolean {
  return NULL_BODY_STATUSES.has(status);
}

/** Decode a base64 string into bytes. */
export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  // Allocate the buffer explicitly so the result is `Uint8Array<ArrayBuffer>`
  // rather than the wider `ArrayBufferLike`, which `BodyInit` and `BlobPart`
  // refuse (they cannot accept a possibly-shared buffer).
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The rule's body as bytes, or `null` when the status cannot carry one.
 *
 * An empty body also yields `null` rather than a zero-length array, so
 * `Response` behaves the same as it would for a real empty 200.
 */
export function decodeRuleBody(rule: MockRule): Uint8Array<ArrayBuffer> | null {
  if (isNullBodyStatus(rule.status)) return null;
  if (rule.body === "") return null;
  if (rule.body_encoding === "base64") return base64ToBytes(rule.body);
  return new TextEncoder().encode(rule.body);
}

/**
 * Does this text look like JSON?
 *
 * Only used to pick a default `content-type`, so a cheap shape check is
 * enough — a body that merely starts with `{` and is not valid JSON still
 * gets `application/json`, which is what the author meant.
 */
function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === "") return false;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Headers the mock response carries.
 *
 * Rule headers win. When the rule sets no `content-type` one is inferred, so
 * `--body '{"id":1}'` is usable from a page without also passing a header —
 * the common case for frontend integration. Binary bodies default to
 * `application/octet-stream` because there is nothing to infer from.
 */
export function headersFromRule(rule: MockRule): Record<string, string> {
  const headers: Record<string, string> = {};
  let hasContentType = false;

  for (const header of rule.headers) {
    const key = header.name.toLowerCase();
    if (key === "content-type") hasContentType = true;
    headers[header.name] = header.value;
  }

  if (!hasContentType && !isNullBodyStatus(rule.status) && rule.body !== "") {
    if (rule.body_encoding === "base64") {
      headers["content-type"] = "application/octet-stream";
    } else if (looksLikeJson(rule.body)) {
      headers["content-type"] = "application/json";
    } else {
      headers["content-type"] = "text/plain; charset=utf-8";
    }
  }

  return headers;
}

/** Build the `ResponseInit` a rule describes. */
export function responseInitFromRule(rule: MockRule): ResponseInit {
  return {
    status: rule.status,
    headers: headersFromRule(rule),
  };
}

/**
 * Materialise the response for a rule.
 *
 * The caller is responsible for honouring `delay_ms` before resolving; this
 * function is synchronous so the delay stays visible at the call site instead
 * of hiding inside response construction.
 */
export function toResponse(rule: MockRule): Response {
  const body = decodeRuleBody(rule);
  return new Response(body, responseInitFromRule(rule));
}
