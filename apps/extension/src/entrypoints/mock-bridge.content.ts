import { publishMockRules, subscribeMockRulesRequests } from "@/mock/bridge";
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
