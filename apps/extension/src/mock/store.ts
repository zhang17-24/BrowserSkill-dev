import { defaultStorage, type StorageBackend } from "@/lib/instance-id";
import type { MockRule } from "@/transport/types";
import { MOCK_RULES_STORAGE_KEY, normaliseRules } from "./rules";

/**
 * The rule table, backed by `chrome.storage.local`.
 *
 * Storage rather than a session because the rules are a property of the
 * browser profile: they must survive a page reload, a navigation, a service
 * worker restart and a daemon restart, and the rules page and the daemon must
 * read the same table.
 *
 * `StorageBackend` is injected so tests can drive the table without a browser.
 */

/** Read the rule set. Malformed entries are dropped, never thrown on. */
export async function readMockRules(storage: StorageBackend = defaultStorage()): Promise<MockRule[]> {
  const items = await storage.get(MOCK_RULES_STORAGE_KEY);
  return normaliseRules(items[MOCK_RULES_STORAGE_KEY]);
}

/** Replace the rule set wholesale. */
export async function writeMockRules(
  rules: readonly MockRule[],
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [MOCK_RULES_STORAGE_KEY]: [...rules] });
}

/** Subscribe to rule-table changes from any context. Returns an unsubscribe. */
export function subscribeMockRuleStorage(listener: (rules: MockRule[]) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[MOCK_RULES_STORAGE_KEY];
    if (!change) return;
    listener(normaliseRules(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
