import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockRule } from "@/transport/types";
import {
  isMockHitMessage,
  isMockHitRuntimeMessage,
  isMockRulesMessage,
  MOCK_HIT_CHANNEL,
  MOCK_HIT_MESSAGE_KIND,
  MOCK_RULES_CHANNEL,
  type MockHitMessage,
  publishMockHit,
  publishMockRules,
  requestMockRules,
  subscribeMockHits,
  subscribeMockRules,
  subscribeMockRulesRequests,
} from "../bridge";
import { installMockInterceptor, type MockTarget } from "../interceptor";

/**
 * The two content scripts, wired together in one window.
 *
 * `mock-bridge.content.ts` (ISOLATED world) and `mock-page.content.ts` (MAIN
 * world) are injected at `document_start` and their order is not guaranteed.
 * Each half is trivial on its own; the failure mode lives entirely in how they
 * meet, which is what this file pins down:
 *
 * - whichever script starts first, the page's *first* request is still mocked;
 * - a rule edited after load reaches an already-patched page without a reload;
 * - a page whose bridge never arrives is not left hanging.
 *
 * Both sides are reproduced here rather than imported, because the real
 * modules call `defineContentScript`, which only exists inside a WXT build.
 */

function rule(overrides: Partial<MockRule> = {}): MockRule {
  return {
    id: "m_1",
    enabled: true,
    url_pattern: "https://api.example.com/user/*",
    status: 200,
    headers: [],
    body: "mocked",
    body_encoding: "text",
    ...overrides,
  };
}

class FakeXhr extends EventTarget {
  static sent: unknown[] = [];
  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  response: unknown = "";
  responseType = "";
  responseURL = "";

  open(_method: string, url: string): void {
    this.readyState = 1;
    this.responseURL = url;
  }

  send(body?: unknown): void {
    FakeXhr.sent.push(body);
  }
}

/** Mirrors `mock-bridge.content.ts`. */
function startBridgeSide(initial: MockRule[]) {
  let rules = initial;
  publishMockRules(rules);
  const stopRequests = subscribeMockRulesRequests(() => publishMockRules(rules));
  return {
    push(next: MockRule[]) {
      rules = next;
      publishMockRules(rules);
    },
    stop() {
      stopRequests();
    },
  };
}

/** Mirrors `mock-page.content.ts`. */
function startPageSide(target: MockTarget, arrivalTimeoutMs = 1500) {
  let current: MockRule[] = [];
  let settle: ((rules: MockRule[]) => void) | null = null;
  const arrived = new Promise<MockRule[]>((resolve) => {
    settle = resolve;
  });

  const timer = setTimeout(() => {
    if (!settle) return;
    settle(current);
    settle = null;
  }, arrivalTimeoutMs);

  const stopRules = subscribeMockRules((rules) => {
    current = rules;
    if (!settle) return;
    clearTimeout(timer);
    settle(rules);
    settle = null;
  });

  requestMockRules();

  const uninstall = installMockInterceptor(target, {
    getRules: () => (settle ? arrived : current),
    sleep: async () => {},
  });

  return {
    stop() {
      clearTimeout(timer);
      stopRules();
      uninstall();
    },
  };
}

function makeTarget(): MockTarget & { realFetch: ReturnType<typeof vi.fn> } {
  const realFetch = vi.fn(async () => new Response("real", { status: 200 }));
  return {
    fetch: realFetch as unknown as typeof globalThis.fetch,
    XMLHttpRequest: FakeXhr as unknown as typeof globalThis.XMLHttpRequest,
    getBaseUrl: () => "https://app.test/",
    realFetch,
  };
}

/** `postMessage` is a macrotask, so the handshake needs a turn to settle. */
async function settleHandshake(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  FakeXhr.sent = [];
  vi.restoreAllMocks();
});

describe("bridge handshake", () => {
  it("mocks the first request when the page script starts first", async () => {
    // MAIN injected before ISOLATED: the page's handshake request is posted
    // before anything is listening, and must still be answered by the
    // bridge's own publish.
    const target = makeTarget();
    cleanups.push(startPageSide(target).stop);
    const bridge = startBridgeSide([rule({ body: "from-bridge" })]);
    cleanups.push(bridge.stop);

    await settleHandshake();
    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("from-bridge");
  });

  it("mocks the first request when the bridge starts first", async () => {
    // ISOLATED injected before MAIN: the bridge's publish lands before the
    // page script subscribes, and must still be recovered by the handshake
    // request.
    const target = makeTarget();
    const bridge = startBridgeSide([rule({ body: "from-bridge" })]);
    cleanups.push(bridge.stop);
    cleanups.push(startPageSide(target).stop);

    await settleHandshake();
    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("from-bridge");
  });

  it("applies a rule added after the page was already patched", async () => {
    // The rules page writes to storage while the page is live; the bridge
    // pushes the new set and the next request picks it up without a reload.
    const target = makeTarget();
    const bridge = startBridgeSide([]);
    cleanups.push(bridge.stop);
    cleanups.push(startPageSide(target).stop);
    await settleHandshake();

    await target.fetch("https://api.example.com/user/1");
    expect(target.realFetch).toHaveBeenCalledTimes(1);

    bridge.push([rule({ body: "added-later" })]);
    await settleHandshake();
    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("added-later");
  });

  it("stops mocking when the rule set is cleared", async () => {
    const target = makeTarget();
    const bridge = startBridgeSide([rule()]);
    cleanups.push(bridge.stop);
    cleanups.push(startPageSide(target).stop);
    await settleHandshake();

    await target.fetch("https://api.example.com/user/1");
    expect(target.realFetch).not.toHaveBeenCalled();

    bridge.push([]);
    await settleHandshake();
    await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
  });

  it("lets the page through rather than hanging when the bridge never arrives", async () => {
    // A bridge that fails to load must degrade to "no mocking", not to a page
    // whose first request never settles.
    const target = makeTarget();
    cleanups.push(startPageSide(target, 20).stop);

    const response = await target.fetch("https://api.example.com/user/1");

    expect(target.realFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("real");
  });

  it("keeps the two worlds separate: only the page side patches fetch", async () => {
    // The bridge must not install an interceptor of its own, or a frame would
    // end up with two patches and apply a delay twice.
    const original = globalThis.fetch;
    const target = makeTarget();
    const bridge = startBridgeSide([rule()]);
    cleanups.push(bridge.stop);
    cleanups.push(startPageSide(target).stop);
    await settleHandshake();

    expect(globalThis.fetch).toBe(original);
  });
});

describe("mock hit reporting", () => {
  // The fact that a request never reached the network exists only in the MAIN
  // world, which cannot reach `chrome.runtime`. It crosses the same boundary the
  // rule set does, in the opposite direction — so the guards matter for the same
  // reason: the background is reachable from every content script in every tab.
  it("carries a hit from the page side to the bridge side", async () => {
    const hits: MockHitMessage[] = [];
    cleanups.push(
      subscribeMockHits((hit) => {
        hits.push(hit);
      }),
    );

    publishMockHit({ url: "https://api.test/user/1", method: "GET", status: 200, ruleId: "m_1" });
    await settleHandshake();

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      url: "https://api.test/user/1",
      method: "GET",
      status: 200,
      ruleId: "m_1",
    });
  });

  it("carries a hit whose rule has no id", async () => {
    const hits: MockHitMessage[] = [];
    cleanups.push(
      subscribeMockHits((hit) => {
        hits.push(hit);
      }),
    );

    publishMockHit({ url: "https://api.test/x", method: "POST", status: 503 });
    await settleHandshake();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.ruleId).toBeUndefined();
  });

  it("rejects a malformed runtime hit rather than writing an unreadable row", async () => {
    const valid = {
      kind: MOCK_HIT_MESSAGE_KIND,
      url: "https://api.test/x",
      method: "GET",
      status: 200,
    };
    expect(isMockHitRuntimeMessage(valid)).toBe(true);

    // `status` is what the network view renders and `url` is what identifies the
    // request; neither can be missing or non-finite.
    expect(isMockHitRuntimeMessage({ ...valid, status: Number.NaN })).toBe(false);
    expect(isMockHitRuntimeMessage({ ...valid, status: "200" })).toBe(false);
    expect(isMockHitRuntimeMessage({ ...valid, url: undefined })).toBe(false);
    expect(isMockHitRuntimeMessage({ ...valid, method: 7 })).toBe(false);
    expect(isMockHitRuntimeMessage({ ...valid, ruleId: 7 })).toBe(false);
    expect(isMockHitRuntimeMessage({ ...valid, kind: "other" })).toBe(false);
    expect(isMockHitRuntimeMessage(null)).toBe(false);
  });

  it("keeps the rule-set and hit channels from being read as each other", () => {
    // They share the window, so a guard loose enough to match both would let a
    // rule set arrive as a hit (or the reverse).
    expect(isMockHitMessage({ channel: MOCK_RULES_CHANNEL, rules: [] })).toBe(false);
    expect(
      isMockRulesMessage({
        channel: MOCK_HIT_CHANNEL,
        url: "https://x",
        method: "GET",
        status: 200,
      }),
    ).toBe(false);
  });
});
