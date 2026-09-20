import { useCallback, useEffect, useState } from "react";
import type { MockRule } from "@/transport/types";
import { readMockRules, subscribeMockRuleStorage, writeMockRules } from "./store";

/**
 * Live view of the mock rule table.
 *
 * Reads once, then follows `chrome.storage.onChanged` so a rule added by an
 * agent through `bsk mock add` appears on an already-open rules page without
 * a refresh — the page and the agent are editing the same table, and a stale
 * view of it would be actively misleading.
 */
export interface MockRulesState {
  rules: MockRule[];
  loading: boolean;
  error: string | null;
  /** Replace the table. The storage listener brings the new value back. */
  save: (next: readonly MockRule[]) => Promise<void>;
}

export function useMockRules(): MockRulesState {
  const [rules, setRules] = useState<MockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    readMockRules()
      .then((loaded) => {
        if (cancelled) return;
        setRules(loaded);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = subscribeMockRuleStorage((next) => {
      if (!cancelled) setRules(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const save = useCallback(async (next: readonly MockRule[]) => {
    setError(null);
    try {
      await writeMockRules(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  return { rules, loading, error, save };
}
