import { requestMockRules, subscribeMockRules } from "@/mock/bridge";
import { installMockInterceptor, type MockTarget } from "@/mock/interceptor";
import type { MockRule } from "@/transport/types";

/**
 * Installs the request interceptor into the page's own JavaScript context.
 *
 * This has to be the MAIN world: replacing `window.fetch` from an
 * ISOLATED-world content script would only affect the content script's own
 * copy of the global, not the page's. The cost is that this script cannot
 * reach `chrome.storage`, so the rule set arrives over `postMessage` from
 * `mock-bridge.content.ts`.
 *
 * `runAt: "document_start"` and `allFrames: true` are both load-bearing.
 * `document_start` because the patch must be in place before the page's first
 * request, and a patch installed at `document_end` would miss everything the
 * app fires during bootstrap. `allFrames` because apps commonly render into
 * an iframe, and a frame without the patch would talk to the real backend.
 */

/**
 * How long a request waits for the rule set before being let through.
 *
 * Bounded on purpose: if the bridge script fails to load, a page must degrade
 * to "no mocking" rather than hang on its first request forever.
 */
const RULES_ARRIVAL_TIMEOUT_MS = 1500;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",

  main() {
    let current: MockRule[] = [];
    let settle: ((rules: MockRule[]) => void) | null = null;

    const arrived = new Promise<MockRule[]>((resolve) => {
      settle = resolve;
    });

    const timer = setTimeout(() => {
      if (!settle) return;
      settle(current);
      settle = null;
    }, RULES_ARRIVAL_TIMEOUT_MS);

    subscribeMockRules((rules) => {
      current = rules;
      if (!settle) return;
      clearTimeout(timer);
      settle(rules);
      settle = null;
    });

    // Both content scripts are injected at document_start and their order is
    // not guaranteed, so a proactive publish from the bridge may already have
    // happened before this script existed. Asking closes that race.
    requestMockRules();

    const target: MockTarget = {
      get fetch() {
        return window.fetch;
      },
      set fetch(next: typeof globalThis.fetch) {
        window.fetch = next;
      },
      XMLHttpRequest: window.XMLHttpRequest,
      getBaseUrl: () => window.location.href,
    };

    installMockInterceptor(target, {
      // The first request awaits the handshake; afterwards the array is read
      // synchronously so there is no per-request promise churn.
      getRules: () => (settle ? arrived : current),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
});
