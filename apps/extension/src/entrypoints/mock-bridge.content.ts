import {
  publishMockRules,
  subscribeMockHits,
  subscribeMockRulesRequests,
  toMockHitRuntimeMessage,
} from "@/mock/bridge";
import { readMockRules, subscribeMockRuleStorage } from "@/mock/store";

/**
 * Bridges `chrome.storage.local` into the page's MAIN world.
 *
 * Runs in the ISOLATED world, which is the only side that can read
 * `chrome.storage`. It pushes the rule set across with `postMessage` on load,
 * answers the MAIN script's handshake request, and keeps the page's copy in
 * sync while the rules page is edited — so a rule added through the popup or
 * through `bsk mock add` takes effect on the next request without a reload.
 */

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  // Without these, `about:blank` and `srcdoc` frames get neither script. With
  // them, this one is injected into those frames — verified by asking the bridge
  // in a `srcdoc` frame to answer a rule-set request — while the MAIN-world
  // script is not, so requests from those frames are still unmocked. See the
  // note in `mock-page.content.ts`; the flags stay because this half is
  // necessary for any fix that does land the interceptor.
  matchAboutBlank: true,
  matchOriginAsFallback: true,

  async main() {
    let rules = await readMockRules().catch(() => []);
    publishMockRules(rules);

    // The MAIN script asks because it may have been injected after the
    // publish above. Answering from the cached copy avoids a second storage
    // round-trip on the hot path of every page load.
    subscribeMockRulesRequests(() => publishMockRules(rules));

    subscribeMockRuleStorage((next) => {
      rules = next;
      publishMockRules(rules);
    });

    // Forward each locally-answered request to the background, which is where the
    // network buffer lives. Fire-and-forget on purpose: the page has already
    // received its response, and a tab with no capture attached (or a service
    // worker still waking up) must not turn a working mock into an error.
    subscribeMockHits((hit) => {
      void chrome.runtime.sendMessage(toMockHitRuntimeMessage(hit)).catch(() => {});
    });

    // A page restored from the back/forward cache does not re-run content
    // scripts, and the rules may have changed while it was frozen.
    window.addEventListener("pageshow", (event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      void readMockRules()
        .then((next) => {
          rules = next;
          publishMockRules(rules);
        })
        .catch(() => {});
    });
  },
});
