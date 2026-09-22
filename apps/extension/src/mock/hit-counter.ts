import { type MockHitTable, pruneHits, type RuleHits } from "./hits";

/**
 * Counts rule hits without turning a busy page into a storage write per request.
 *
 * A mocked request is answered in microseconds and a polling page issues many per
 * second, so writing storage once per hit would make the counter cost more than
 * the mocking it is measuring. Hits accumulate in memory and are flushed on a
 * debounce, which coalesces a burst into one write while still persisting a lone
 * hit quickly.
 *
 * Every dependency is injected, so the batching is testable without a browser —
 * the same reason the interceptor takes `sleep` rather than calling `setTimeout`.
 */

export interface HitCounterDeps {
  read: () => Promise<MockHitTable>;
  write: (table: MockHitTable) => Promise<void>;
  now: () => number;
  /** Run `flush` after `ms`. Injected so tests advance time themselves. */
  schedule: (flush: () => void, ms: number) => void;
}

export interface HitCounterOptions {
  /**
   * How long to wait after the last hit before writing.
   *
   * Short enough that a lone hit is durable almost immediately, long enough that
   * a burst of requests becomes one write.
   */
  debounceMs?: number;
}

export interface HitCounter {
  /** Count one hit for a rule. Synchronous and non-throwing by design. */
  record: (ruleId: string) => void;
  /** Write anything pending now. Awaited on teardown so counts survive a suspend. */
  flush: () => Promise<void>;
  /** Rule ids recorded but not yet written. Test/observability helper. */
  pendingCount: () => number;
}

const DEFAULT_DEBOUNCE_MS = 500;

export function createHitCounter(
  deps: HitCounterDeps,
  options: HitCounterOptions = {},
): HitCounter {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // Deltas rather than totals: the table on disk may have been written by another
  // context — the rules page resetting counters, say — so a flush merges into
  // what is stored instead of overwriting it with a stale in-memory view.
  const pending = new Map<string, RuleHits>();
  let armed = false;

  const flush = async (): Promise<void> => {
    armed = false;
    if (pending.size === 0) return;

    const deltas = new Map(pending);
    pending.clear();

    // Fails in the direction that loses counts rather than breaking anything: a
    // hit count is not worth an error, and the requests happened regardless.
    let stored: MockHitTable = {};
    try {
      stored = await deps.read();
    } catch {
      stored = {};
    }
    for (const [ruleId, delta] of deltas) {
      const existing = stored[ruleId];
      stored[ruleId] = {
        count: (existing?.count ?? 0) + delta.count,
        lastAt: Math.max(existing?.lastAt ?? 0, delta.lastAt),
      };
    }
    try {
      await deps.write(pruneHits(stored));
    } catch {
      // Dropped on purpose; see above.
    }
  };

  return {
    record(ruleId: string) {
      const existing = pending.get(ruleId);
      pending.set(ruleId, {
        count: (existing?.count ?? 0) + 1,
        lastAt: deps.now(),
      });
      if (armed) return;
      armed = true;
      // No cancellation handle: a timer that fires after an explicit flush finds
      // an empty batch and returns, so a stale callback is a no-op rather than a
      // second write.
      deps.schedule(() => {
        void flush();
      }, debounceMs);
    },
    flush,
    pendingCount: () => pending.size,
  };
}
