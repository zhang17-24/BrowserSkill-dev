import { defaultStorage, type StorageBackend } from "@/lib/instance-id";

/**
 * How often each rule has answered a request, backed by `chrome.storage.local`.
 *
 * The point is to answer a question the rules table cannot: *which* rule is
 * actually in effect. A rule that never fires is either wrong or shadowed by an
 * earlier one, and either way it silently rewrites nothing — which looks exactly
 * like a rule that is working, from the outside.
 *
 * Kept separate from the rule table so a hit never rewrites the rules: every
 * page's bridge listens for rule-table changes, and waking all of them to bump a
 * counter would be a lot of work for a number nobody is requesting yet.
 */

/** Storage key holding the hit table. */
export const MOCK_HITS_STORAGE_KEY = "bsk_mock_hits";

/**
 * How many rule ids to keep counts for.
 *
 * Counts are keyed by rule id, and a deleted rule's id never comes back, so the
 * table would grow forever without a cap. Pruning by least-recently-fired keeps
 * the entries that matter and needs no knowledge of the rule table.
 */
export const MAX_TRACKED_RULES = 1000;

export interface RuleHits {
  /** How many requests this rule has answered. */
  count: number;
  /** When it last answered, in epoch milliseconds. */
  lastAt: number;
}

export type MockHitTable = Record<string, RuleHits>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce stored data into a hit table, dropping what cannot be read.
 *
 * Returns an empty table for anything unusable rather than throwing, for the same
 * reason the rule table does: a corrupt counter must not be able to take down the
 * page that reads it, and a hit count is not worth an error.
 */
export function normaliseHits(raw: unknown): MockHitTable {
  if (!isPlainObject(raw)) return {};
  const table: MockHitTable = {};
  for (const [ruleId, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const count = value.count;
    const lastAt = value.lastAt;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    if (typeof lastAt !== "number" || !Number.isFinite(lastAt)) continue;
    table[ruleId] = { count, lastAt };
  }
  return table;
}

/** Drop the least recently fired entries once the table is over its cap. */
export function pruneHits(table: MockHitTable): MockHitTable {
  const entries = Object.entries(table);
  if (entries.length <= MAX_TRACKED_RULES) return table;
  const keep = entries.sort(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_TRACKED_RULES);
  return Object.fromEntries(keep);
}

/** Read the hit table. Malformed entries are dropped, never thrown on. */
export async function readMockHits(
  storage: StorageBackend = defaultStorage(),
): Promise<MockHitTable> {
  const items = await storage.get(MOCK_HITS_STORAGE_KEY);
  return normaliseHits(items[MOCK_HITS_STORAGE_KEY]);
}

/** Replace the hit table wholesale. */
export async function writeMockHits(
  table: MockHitTable,
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [MOCK_HITS_STORAGE_KEY]: pruneHits(table) });
}

/** Subscribe to hit-table changes from any context. Returns an unsubscribe. */
export function subscribeMockHitStorage(listener: (table: MockHitTable) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[MOCK_HITS_STORAGE_KEY];
    if (!change) return;
    listener(normaliseHits(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
