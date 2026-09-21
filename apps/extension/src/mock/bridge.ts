import type { MockRule } from "@/transport/types";
import { normaliseRules } from "./rules";

/**
 * The contract between the two content scripts that make mocking work.
 *
 * The interceptor has to run in the page's own JavaScript context (MAIN
 * world) to replace `window.fetch`, but that world cannot reach
 * `chrome.storage`. So the ISOLATED-world script reads storage and hands the
 * rules across with `window.postMessage`.
 *
 * Both scripts are injected at `document_start`, and their order is not
 * guaranteed — so a proactive publish alone would race the subscriber and
 * leave the interceptor waiting for rules that were already sent. The
 * handshake below closes that: the MAIN side announces itself with
 * {@link requestMockRules} and the ISOLATED side answers, whatever the
 * injection order was.
 *
 * On trust: a page can also post on this channel, so it could feed the
 * interceptor rules of its own. That is not a real escalation — the page
 * already controls everything in its own context, and a forged rule can only
 * change what that same page receives. The messages are still shape-checked
 * so an unrelated `postMessage` on the same channel cannot corrupt the set.
 */

/** ISOLATED → MAIN: here is the rule set. */
export const MOCK_RULES_CHANNEL = "bsk:mock-rules";

/** MAIN → ISOLATED: send me the rule set now. */
export const MOCK_RULES_REQUEST_CHANNEL = "bsk:mock-rules-request";

export interface MockRulesMessage {
  channel: typeof MOCK_RULES_CHANNEL;
  rules: MockRule[];
}

export interface MockRulesRequestMessage {
  channel: typeof MOCK_RULES_REQUEST_CHANNEL;
}

export function isMockRulesMessage(value: unknown): value is MockRulesMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === MOCK_RULES_CHANNEL && Array.isArray(candidate.rules);
}

export function isMockRulesRequestMessage(value: unknown): value is MockRulesRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === MOCK_RULES_REQUEST_CHANNEL;
}

/** ISOLATED side: publish the rule set to whichever context is listening. */
export function publishMockRules(rules: readonly MockRule[], target: Window = window): void {
  const message: MockRulesMessage = { channel: MOCK_RULES_CHANNEL, rules: [...rules] };
  target.postMessage(message, targetOrigin(target));
}

/** MAIN side: ask for the rule set. */
export function requestMockRules(target: Window = window): void {
  const message: MockRulesRequestMessage = { channel: MOCK_RULES_REQUEST_CHANNEL };
  target.postMessage(message, targetOrigin(target));
}

/**
 * `targetOrigin` for an outbound message.
 *
 * The page's own origin where it has one, so the rules are not handed to a
 * third-party frame that happens to be listening. Opaque origins (`file://`,
 * sandboxed frames) report `"null"`, where no specific target is addressable
 * and `"*"` is the only option; the payload is user-authored configuration
 * rather than a secret, so that is acceptable.
 */
function targetOrigin(target: Window): string {
  const origin = target.location?.origin;
  return origin && origin !== "null" ? origin : "*";
}

/**
 * Is this message from a context we accept rules from?
 *
 * Origin is compared rather than window identity. Identity looks like the
 * tighter check but is not portable: happy-dom hands the listener a different
 * `Window` instance than the one that posted, which would silently reject
 * every legitimate message and leave the interceptor waiting forever for
 * rules that were already sent. A wrong origin is rejected either way, and a
 * same-origin frame could already script this document, so nothing is given
 * up by allowing it.
 */
function isTrustedSender(event: MessageEvent, target: Window): boolean {
  const own = target.location?.origin;
  if (!own) return true;
  return event.origin === own;
}

/**
 * Listen for rule sets.
 */
export function subscribeMockRules(
  handler: (rules: MockRule[]) => void,
  target: Window = window,
): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isTrustedSender(event, target)) return;
    if (!isMockRulesMessage(event.data)) return;
    handler(normaliseRules(event.data.rules));
  };
  target.addEventListener("message", listener);
  return () => target.removeEventListener("message", listener);
}

/** ISOLATED side: answer rule-set requests. */
export function subscribeMockRulesRequests(
  handler: () => void,
  target: Window = window,
): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isTrustedSender(event, target)) return;
    if (!isMockRulesRequestMessage(event.data)) return;
    handler();
  };
  target.addEventListener("message", listener);
  return () => target.removeEventListener("message", listener);
}

/**
 * MAIN → ISOLATED: a rule just answered a request locally.
 *
 * The fact worth recording — "this request never went to the network" — exists
 * only in the interceptor, in the MAIN world, which cannot reach
 * `chrome.runtime`. So it crosses the same boundary the rule set does, in the
 * opposite direction.
 */
export const MOCK_HIT_CHANNEL = "bsk:mock-hit";

/** `kind` the ISOLATED side forwards a hit under, for the background. */
export const MOCK_HIT_MESSAGE_KIND = "bsk_mock_hit";

/** What the interceptor knows about a request it answered. */
export interface MockHit {
  url: string;
  method: string;
  status: number;
  ruleId?: string;
}

export interface MockHitMessage extends MockHit {
  channel: typeof MOCK_HIT_CHANNEL;
}

export interface MockHitRuntimeMessage extends MockHit {
  kind: typeof MOCK_HIT_MESSAGE_KIND;
}

function isMockHitFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.url === "string" &&
    typeof value.method === "string" &&
    typeof value.status === "number" &&
    Number.isFinite(value.status) &&
    (value.ruleId === undefined || typeof value.ruleId === "string")
  );
}

export function isMockHitMessage(value: unknown): value is MockHitMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === MOCK_HIT_CHANNEL && isMockHitFields(candidate);
}

export function isMockHitRuntimeMessage(value: unknown): value is MockHitRuntimeMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // Shape-checked on the receiving side as well, not just on send: the
  // background's listener is reachable from every content script in every tab,
  // so a malformed message must not be able to write into a tab's buffer.
  return candidate.kind === MOCK_HIT_MESSAGE_KIND && isMockHitFields(candidate);
}

/** MAIN side: report a locally answered request. */
export function publishMockHit(hit: MockHit, target: Window = window): void {
  const message: MockHitMessage = {
    channel: MOCK_HIT_CHANNEL,
    url: hit.url,
    method: hit.method,
    status: hit.status,
    ...(hit.ruleId !== undefined ? { ruleId: hit.ruleId } : {}),
  };
  target.postMessage(message, targetOrigin(target));
}

/** ISOLATED side: listen for hits from the page. */
export function subscribeMockHits(
  handler: (hit: MockHitMessage) => void,
  target: Window = window,
): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isTrustedSender(event, target)) return;
    if (!isMockHitMessage(event.data)) return;
    handler(event.data);
  };
  target.addEventListener("message", listener);
  return () => target.removeEventListener("message", listener);
}

/** ISOLATED side: the runtime message the background expects. */
export function toMockHitRuntimeMessage(hit: MockHitMessage): MockHitRuntimeMessage {
  return {
    kind: MOCK_HIT_MESSAGE_KIND,
    url: hit.url,
    method: hit.method,
    status: hit.status,
    ...(hit.ruleId !== undefined ? { ruleId: hit.ruleId } : {}),
  };
}
