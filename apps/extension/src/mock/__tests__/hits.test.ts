import { describe, expect, it } from "vitest";
import { MAX_TRACKED_RULES, type MockHitTable, normaliseHits, pruneHits } from "../hits";

describe("normaliseHits", () => {
  it("keeps readable entries and drops the rest", () => {
    const table = normaliseHits({
      m_a: { count: 3, lastAt: 100 },
      m_b: { count: -1, lastAt: 100 },
      m_c: { count: 2 },
      m_d: { count: "3", lastAt: 100 },
      m_e: null,
      m_f: [1, 2],
    });
    expect(Object.keys(table)).toEqual(["m_a"]);
    expect(table.m_a).toEqual({ count: 3, lastAt: 100 });
  });

  it("returns an empty table for anything unusable", () => {
    // A corrupt counter must not be able to take the page down, for the same
    // reason the rule table tolerates junk.
    for (const raw of [undefined, null, "nope", 7, [], { m_a: { count: Number.NaN, lastAt: 1 } }]) {
      expect(normaliseHits(raw)).toEqual({});
    }
  });
});

describe("pruneHits", () => {
  it("keeps the most recently fired entries when over the cap", () => {
    const table: MockHitTable = {};
    const total = MAX_TRACKED_RULES + 10;
    for (let index = 0; index < total; index += 1) {
      table[`m_${index}`] = { count: 1, lastAt: index };
    }

    const pruned = pruneHits(table);
    expect(Object.keys(pruned)).toHaveLength(MAX_TRACKED_RULES);
    // The ten least recently fired went; a deleted rule's id never comes back,
    // so without this the table would grow forever.
    expect(pruned.m_0).toBeUndefined();
    expect(pruned[`m_${total - 1}`]).toBeDefined();
  });

  it("returns the same table when it is at or under the cap", () => {
    const table: MockHitTable = { m_a: { count: 1, lastAt: 1 } };
    expect(pruneHits(table)).toBe(table);
  });
});
