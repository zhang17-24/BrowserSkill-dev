import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button } from "@browser-skill/ui";
import { RiExternalLinkLine, RiDeleteBinLine } from "@remixicon/react";
import { useState } from "react";
import { useMockRules } from "@/mock/use-mock-rules";
import { Switch } from "./switch";

/**
 * Compact rules view inside the popup.
 *
 * Answers the question the popup is opened with — "what is currently
 * rewriting my traffic?" — without trying to be the editor. Long URL patterns
 * and response bodies need room, so editing lives on the full page.
 */
export function MockRules() {
  const { t } = useTranslation("extension");
  const { rules, loading, error, save } = useMockRules();
  const [busy, setBusy] = useState(false);

  const openPage = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("mock.html") });
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await save([]);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string | undefined, enabled: boolean) => {
    if (!id) return;
    setBusy(true);
    try {
      await save(rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2.5" data-slot="popup-mock-body">
      <p className="text-[11px] leading-snug text-muted-foreground" data-slot="popup-mock-scope">
        {t("popup.mock.scopeHint")}
      </p>

      {error && (
        <div
          className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive"
          data-slot="popup-mock-error"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[11px] text-muted-foreground">{t("mock.loading")}</p>
      ) : rules.length === 0 ? (
        <p
          className="rounded-xl border border-border/80 bg-card/60 px-3 py-3 text-[11px] leading-snug text-muted-foreground"
          data-slot="popup-mock-empty"
        >
          {t("popup.mock.empty")}
        </p>
      ) : (
        <>
          <div
            className="flex items-center justify-between text-[11px] text-muted-foreground"
            data-slot="popup-mock-count"
          >
            <span>{t("popup.mock.count", { count: rules.length })}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              disabled={busy}
              onClick={() => {
                void clearAll();
              }}
              data-slot="popup-mock-clear"
            >
              <RiDeleteBinLine className="size-3" aria-hidden />
              {t("popup.mock.clearAll")}
            </Button>
          </div>

          <ul className="space-y-1.5" data-slot="popup-mock-list">
            {rules.map((rule) => (
              <li
                key={rule.id ?? rule.url_pattern}
                className="flex items-start gap-2 rounded-lg border border-border/80 bg-card/60 px-2.5 py-2"
                data-slot="popup-mock-rule"
                data-enabled={rule.enabled ? "true" : "false"}
              >
                <span className="mt-0.5 shrink-0">
                  <Switch
                    checked={rule.enabled}
                    disabled={busy}
                    aria-label={t("mock.enabled")}
                    onCheckedChange={(next) => {
                      void toggle(rule.id, next);
                    }}
                    data-slot="popup-mock-rule-toggle"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate font-mono text-[10px] leading-snug text-foreground/90"
                    title={rule.url_pattern}
                    data-slot="popup-mock-rule-url"
                  >
                    {rule.url_pattern}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="px-1 py-0 text-[9px] font-medium"
                      data-slot="popup-mock-rule-method"
                    >
                      {rule.method ?? t("mock.methodAny")}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{rule.status}</span>
                    {rule.delay_ms !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        +{rule.delay_ms}ms
                      </span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 w-full px-2.5 text-xs"
        onClick={openPage}
        data-slot="popup-mock-open-page"
      >
        <RiExternalLinkLine className="size-3.5" aria-hidden />
        {t("popup.mock.openPage")}
      </Button>
    </section>
  );
}
