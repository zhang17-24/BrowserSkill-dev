import { useEffect, useState } from "react";
import { type MockHitTable, readMockHits, subscribeMockHitStorage } from "./hits";

/**
 * Live view of the hit counts.
 *
 * Follows `chrome.storage.onChanged` rather than polling, so a rule that fires
 * while the rules page is open bumps its own count — which is the whole point of
 * showing them: watching a number move is how you learn a rule is live, and
 * watching one stay at zero is how you learn it is shadowed or wrong.
 *
 * A read failure yields an empty table rather than an error state. The counts are
 * a diagnostic, and "no counts yet" is indistinguishable from "counts
 * unavailable" in the only way that matters here.
 */
export interface MockHitsState {
  hits: MockHitTable;
  loading: boolean;
}

export function useMockHits(): MockHitsState {
  const [hits, setHits] = useState<MockHitTable>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    readMockHits()
      .then((loaded) => {
        if (!cancelled) setHits(loaded);
      })
      .catch(() => {
        if (!cancelled) setHits({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = subscribeMockHitStorage((next) => {
      if (!cancelled) setHits(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { hits, loading };
}
