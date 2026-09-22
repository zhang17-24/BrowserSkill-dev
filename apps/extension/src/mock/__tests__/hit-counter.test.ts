import { describe, expect, it } from "vitest";
import { createHitCounter } from "../hit-counter";
import type { MockHitTable } from "../hits";

/**
 * Drives the counter with an injectable timer, so a test decides when the
 * debounced flush happens instead of waiting out a real one.
 */
function harness(initial: MockHitTable = {}, now = 1000) {
  let stored: MockHitTable = { ...initial };
  const timers: Array<() => void> = [];
  const writes: MockHitTable[] = [];
  const counter = createHitCounter({
    read: async () => ({ ...stored }),
    write: async (table) => {
      stored = { ...table };
      writes.push({ ...table });
    },
    now: () => now,
    schedule: (flush) => {
      timers.push(flush);
    },
  });
  return {
    counter,
    writes,
    stored: () => ({ ...stored }),
    /** Fire the debounced flush, then let its awaits settle. */
    async tick() {
      timers.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pendingTimers: () => timers.length,
  };
}

describe("createHitCounter", () => {
  it("coalesces a burst into a single write", async () => {
    const h = harness();
    for (let index = 0; index < 50; index += 1) h.counter.record("m_a");

    expect(h.counter.pendingCount()).toBe(1);
    expect(h.writes).toHaveLength(0);
    // One timer for the whole burst: a write per hit would make counting cost
    // more than the mocking it measures.
    expect(h.pendingTimers()).toBe(1);

    await h.tick();
    expect(h.writes).toHaveLength(1);
    expect(h.stored().m_a).toEqual({ count: 50, lastAt: 1000 });
  });

  it("adds to what is already stored instead of overwriting it", async () => {
    // Another context may have written the table meanwhile — the rules page
    // resetting counters, say — so a flush merges into the stored value.
    const h = harness({ m_a: { count: 5, lastAt: 500 } });
    h.counter.record("m_a");
    h.counter.record("m_b");

    await h.tick();
    expect(h.stored().m_a).toEqual({ count: 6, lastAt: 1000 });
    expect(h.stored().m_b).toEqual({ count: 1, lastAt: 1000 });
  });

  it("counts each rule separately within one batch", async () => {
    const h = harness();
    h.counter.record("m_a");
    h.counter.record("m_a");
    h.counter.record("m_b");

    await h.tick();
    expect(h.stored().m_a.count).toBe(2);
    expect(h.stored().m_b.count).toBe(1);
  });

  it("keeps the newest lastAt when merging", async () => {
    const h = harness({ m_a: { count: 1, lastAt: 9_000 } }, 1000);
    h.counter.record("m_a");
    await h.tick();
    // The stored timestamp is newer than this context's clock; a stale one must
    // not move it backwards.
    expect(h.stored().m_a.lastAt).toBe(9_000);
  });

  it("flush writes immediately, and the armed timer then writes nothing", async () => {
    const h = harness();
    h.counter.record("m_a");
    await h.counter.flush();
    expect(h.writes).toHaveLength(1);

    // The timer armed by `record` still fires; it must not write an empty batch.
    await h.tick();
    expect(h.writes).toHaveLength(1);
  });

  it("loses counts rather than failing when storage is unavailable", async () => {
    const counter = createHitCounter({
      read: async () => {
        throw new Error("storage gone");
      },
      write: async () => {
        throw new Error("storage gone");
      },
      now: () => 1,
      schedule: (flush) => flush(),
    });

    counter.record("m_a");
    await expect(counter.flush()).resolves.toBeUndefined();
    expect(counter.pendingCount()).toBe(0);
  });
});
