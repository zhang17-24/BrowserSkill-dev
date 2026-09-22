import { useTranslation } from "@browser-skill/i18n/react";
import type { RuleHits } from "./hits";

/**
 * "N hits" or "never fired" for one rule.
 *
 * One component rather than a span in each place, because the wording is the
 * whole point: a rule stuck at zero is shadowed by an earlier rule or simply
 * wrong, and "never fired" reads as that diagnosis where "0 hits" reads as a
 * number. The popup and the rules page must not drift on it.
 *
 * The last-fired time goes in the `title` rather than the label: it answers
 * "is this rule still live, or did it stop firing last week?" without needing
 * relative-time formatting.
 */
export function HitCount({ hits, className }: { hits: RuleHits | undefined; className?: string }) {
  const { t } = useTranslation("extension");
  return (
    <span
      className={className}
      title={hits ? new Date(hits.lastAt).toLocaleString() : undefined}
      data-slot="mock-rule-hits"
    >
      {hits ? t("mock.hitCount", { count: hits.count }) : t("mock.neverHit")}
    </span>
  );
}
