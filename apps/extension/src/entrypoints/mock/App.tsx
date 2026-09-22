import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button, cn, Input, Label } from "@browser-skill/ui";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiPencilLine,
  RiUploadLine,
} from "@remixicon/react";
import { type ChangeEvent, useRef, useState } from "react";
import {
  draftFromRule,
  emptyDraft,
  type RuleDraft,
  ruleFromDraft,
  rulesFromJson,
} from "@/mock/draft";
import { HitCount } from "@/mock/hit-count";
import type { RuleHits } from "@/mock/hits";
import { applyMockAction } from "@/mock/rules";
import { useMockHits } from "@/mock/use-mock-hits";
import { useMockRules } from "@/mock/use-mock-rules";
import type { MockRule } from "@/transport/types";

/**
 * Full-page mock rule editor.
 *
 * A full page rather than the popup because the interesting fields are long:
 * URL patterns with query strings, and JSON response bodies. A 340px popup
 * would force horizontal scrolling on exactly the content that matters.
 *
 * Reads and writes the same `chrome.storage.local` table the agent writes
 * through `bsk mock`, so a rule added by either side appears on the other
 * without a refresh.
 */

const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export function MockApp() {
  const { t } = useTranslation("extension");
  const { rules, loading, error, save } = useMockRules();
  // Shown per rule so "which one is actually in effect" is answerable at a
  // glance: a rule stuck at zero is shadowed by an earlier one, or wrong.
  const { hits } = useMockHits();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const startAdd = () => {
    setFormError(null);
    setNotice(null);
    setDraft(emptyDraft());
  };

  const startEdit = (rule: MockRule) => {
    setFormError(null);
    setNotice(null);
    setDraft(draftFromRule(rule));
  };

  const commit = async () => {
    if (!draft) return;
    const converted = ruleFromDraft(draft);
    if ("error" in converted) {
      setFormError(converted.error);
      return;
    }
    setBusy(true);
    try {
      const exists = rules.some((rule) => rule.id === converted.rule.id);
      const next = exists
        ? rules.map((rule) => (rule.id === converted.rule.id ? converted.rule : rule))
        : [...rules, converted.rule];
      await save(next);
      setDraft(null);
      setFormError(null);
    } catch {
      // `save` already surfaced the reason through the hook's error state.
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: MockRule) => {
    if (!window.confirm(t("mock.deleteConfirm"))) return;
    setBusy(true);
    try {
      await save(rules.filter((entry) => entry.id !== rule.id));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: MockRule, enabled: boolean) => {
    setBusy(true);
    try {
      await save(rules.map((entry) => (entry.id === rule.id ? { ...entry, enabled } : entry)));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Move a rule one position up or down.
   *
   * Goes through `applyMockAction` rather than splicing here, so the bounds rule
   * ("a position past the end is refused, not clamped") lives in the one place
   * that is unit-tested — the same reason `bsk mock move` exists at all. The
   * `session_id` is empty because this is not an RPC: the reducer only reads
   * `action`, `id` and `to`.
   */
  const move = async (rule: MockRule, delta: -1 | 1) => {
    const from = rules.findIndex((entry) => entry.id === rule.id);
    if (from === -1) return;
    const outcome = applyMockAction(rules, {
      session_id: "",
      action: "move",
      id: rule.id,
      to: from + delta,
    });
    if (!outcome.ok) return;
    setBusy(true);
    try {
      await save(outcome.rules);
    } finally {
      setBusy(false);
    }
  };

  const exportRules = () => {
    const blob = new Blob([`${JSON.stringify(rules, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "bsk-mock-rules.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importRules = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const parsed = rulesFromJson(await file.text());
    if ("error" in parsed) {
      setFormError(t("mock.importFailed", { message: parsed.error }));
      return;
    }
    setBusy(true);
    try {
      await save(parsed.rules);
      setFormError(null);
      setNotice(t("popup.mock.count", { count: parsed.rules.length }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6 text-foreground" data-slot="mock-root">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-medium tracking-tight">{t("mock.title")}</h1>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">{t("mock.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={exportRules} disabled={busy}>
            <RiDownloadLine className="size-3.5" aria-hidden />
            {t("mock.export")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <RiUploadLine className="size-3.5" aria-hidden />
            {t("mock.import")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void importRules(event);
            }}
            data-slot="mock-import-input"
          />
          <Button type="button" size="sm" onClick={startAdd} disabled={busy}>
            <RiAddLine className="size-3.5" aria-hidden />
            {t("mock.addRule")}
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      {draft && (
        <RuleEditor
          draft={draft}
          error={formError}
          busy={busy}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setFormError(null);
          }}
          onSave={() => {
            void commit();
          }}
        />
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">{t("mock.loading")}</p>
      ) : rules.length === 0 ? (
        <p
          className="rounded-xl border border-border/80 bg-card/60 px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground"
          data-slot="mock-empty"
        >
          {t("mock.empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-slot="mock-list">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id ?? rule.url_pattern}
              rule={rule}
              busy={busy}
              // Position is precedence: the first match answers, so the ends are
              // where a move stops being possible.
              hits={rule.id !== undefined ? hits[rule.id] : undefined}
              canMoveUp={index > 0}
              canMoveDown={index < rules.length - 1}
              onMoveUp={() => {
                void move(rule, -1);
              }}
              onMoveDown={() => {
                void move(rule, 1);
              }}
              onToggle={(enabled) => {
                void toggle(rule, enabled);
              }}
              onEdit={() => startEdit(rule)}
              onDelete={() => {
                void remove(rule);
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function RuleRow({
  rule,
  hits,
  busy,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: MockRule;
  /** Undefined when this rule has never answered a request. */
  hits: RuleHits | undefined;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("extension");
  return (
    <li
      className={cn(
        "rounded-xl border border-border/80 bg-card/60 px-4 py-3",
        !rule.enabled && "opacity-60",
      )}
      data-slot="mock-rule"
      data-enabled={rule.enabled ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={rule.enabled}
          disabled={busy}
          onChange={(event) => onToggle(event.target.checked)}
          aria-label={t("mock.enabled")}
          className="mt-1 size-3.5 shrink-0"
          data-slot="mock-rule-toggle"
        />
        <div className="min-w-0 flex-1">
          <code
            className="block break-all font-mono text-xs text-foreground"
            data-slot="mock-rule-url"
          >
            {rule.url_pattern}
          </code>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
              {rule.method ?? t("mock.methodAny")}
            </Badge>
            <span>{rule.status}</span>
            {rule.delay_ms !== undefined && <span>+{rule.delay_ms}ms</span>}
            <HitCount hits={hits} />
            {rule.note && <span className="truncate">{rule.note}</span>}
          </div>
          {rule.body !== "" && (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-snug text-muted-foreground">
              {rule.body_encoding === "base64" ? `base64 · ${rule.body.length} chars` : rule.body}
            </pre>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Position is precedence, and adding appends — so without these a rule
              added after a broader one can never fire. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy || !canMoveUp}
            onClick={onMoveUp}
            aria-label={t("mock.moveUp")}
            title={t("mock.moveUp")}
            data-slot="mock-rule-up"
          >
            <RiArrowUpLine className="size-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy || !canMoveDown}
            onClick={onMoveDown}
            aria-label={t("mock.moveDown")}
            title={t("mock.moveDown")}
            data-slot="mock-rule-down"
          >
            <RiArrowDownLine className="size-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy}
            onClick={onEdit}
            data-slot="mock-rule-edit"
          >
            <RiPencilLine className="size-3.5" aria-hidden />
            {t("mock.edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive"
            disabled={busy}
            onClick={onDelete}
            data-slot="mock-rule-delete"
          >
            <RiDeleteBinLine className="size-3.5" aria-hidden />
            {t("mock.delete")}
          </Button>
        </div>
      </div>
    </li>
  );
}

function RuleEditor({
  draft,
  error,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: RuleDraft;
  error: string | null;
  busy: boolean;
  onChange: (next: RuleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation("extension");
  const patch = (part: Partial<RuleDraft>) => onChange({ ...draft, ...part });

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card/60 p-4"
      data-slot="mock-editor"
    >
      <h2 className="text-sm font-medium">{draft.id ? t("mock.editRule") : t("mock.addRule")}</h2>

      <div className="space-y-1.5">
        <Label htmlFor="mock-url" className="text-xs text-muted-foreground">
          {t("mock.urlPattern")}
        </Label>
        <Input
          id="mock-url"
          value={draft.url_pattern}
          onChange={(event) => patch({ url_pattern: event.target.value })}
          placeholder="https://api.example.com/api/user/*"
          className="h-8 font-mono text-xs"
          data-slot="mock-editor-url"
        />
        <p className="text-[10px] leading-snug text-muted-foreground">{t("mock.urlPatternHint")}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="mock-method" className="text-xs text-muted-foreground">
            {t("mock.method")}
          </Label>
          <Input
            id="mock-method"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value })}
            placeholder={t("mock.methodAny")}
            className="h-8 font-mono text-xs uppercase"
            data-slot="mock-editor-method"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mock-status" className="text-xs text-muted-foreground">
            {t("mock.status")}
          </Label>
          <Input
            id="mock-status"
            value={draft.status}
            onChange={(event) => patch({ status: event.target.value })}
            inputMode="numeric"
            className="h-8 font-mono text-xs"
            data-slot="mock-editor-status"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mock-delay" className="text-xs text-muted-foreground">
            {t("mock.delay")}
          </Label>
          <Input
            id="mock-delay"
            value={draft.delay}
            onChange={(event) => patch({ delay: event.target.value })}
            inputMode="numeric"
            className="h-8 font-mono text-xs"
            data-slot="mock-editor-delay"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mock-headers" className="text-xs text-muted-foreground">
          {t("mock.headers")}
        </Label>
        <textarea
          id="mock-headers"
          rows={2}
          value={draft.headers}
          onChange={(event) => patch({ headers: event.target.value })}
          placeholder="content-type: application/json"
          className={TEXTAREA_CLASS}
          data-slot="mock-editor-headers"
        />
        <p className="text-[10px] leading-snug text-muted-foreground">{t("mock.headersHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mock-body" className="text-xs text-muted-foreground">
          {t("mock.body")}
        </Label>
        <textarea
          id="mock-body"
          rows={5}
          value={draft.body}
          onChange={(event) => patch({ body: event.target.value })}
          placeholder={'{"id": 1, "name": "mock"}'}
          className={TEXTAREA_CLASS}
          data-slot="mock-editor-body"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mock-note" className="text-xs text-muted-foreground">
          {t("mock.note")}
        </Label>
        <Input
          id="mock-note"
          value={draft.note}
          onChange={(event) => patch({ note: event.target.value })}
          className="h-8 text-xs"
          data-slot="mock-editor-note"
        />
      </div>

      {error && (
        <div
          className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-slot="mock-editor-error"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("mock.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={busy}
          data-slot="mock-editor-save"
        >
          {t("mock.save")}
        </Button>
      </div>
    </section>
  );
}
