"use client";

import * as React from "react";
import type { FeedbackStatsDto, PageDto, PlatformFeedbackDto, FeedbackStatus, Serialized } from "@sms/types";
import { FEEDBACK_STATUSES } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { FeedbackThread } from "@/components/feedback/FeedbackThread";

type Item = Serialized<PlatformFeedbackDto>;
type Page = Serialized<PageDto<PlatformFeedbackDto>>;
type Stats = Serialized<FeedbackStatsDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  OPEN: "outline",
  REVIEWED: "secondary",
  RESOLVED: "default",
  DISMISSED: "destructive",
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  ...FEEDBACK_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })),
];
const KIND_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All kinds" },
  { value: "COMPLAINT", label: "Complaints" },
  { value: "SUGGESTION", label: "Suggestions" },
];

export function FeedbackInbox({ initial, stats }: { initial: Page; stats: Stats | null }) {
  const [items, setItems] = React.useState<Item[]>(initial.items);
  const [cursor, setCursor] = React.useState<string | null>(initial.nextCursor);
  const [status, setStatus] = React.useState<string>("");
  const [kind, setKind] = React.useState<string>("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async (nextStatus: string, nextKind: string, nextCursor: string | null, append: boolean) => {
    setBusy(true);
    setErr(null);
    const qs = new URLSearchParams({ limit: "25" });
    if (nextStatus) qs.set("status", nextStatus);
    if (nextKind) qs.set("kind", nextKind);
    if (nextCursor) qs.set("cursor", nextCursor);
    const res = await fetch(`/api/sms/operator/feedback?${qs.toString()}`);
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    const page = (await res.json()) as Page;
    setItems((prev) => (append ? [...prev, ...page.items] : page.items));
    setCursor(page.nextCursor);
    if (!append) setSelected(new Set());
  }, []);

  const changeStatus = (s: string) => {
    setStatus(s);
    void load(s, kind, null, false);
  };
  const changeKind = (k: string) => {
    setKind(k);
    void load(status, k, null, false);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const patchLocal = (updated: Item) => setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));

  const bulk = async (newStatus: FeedbackStatus) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/sms/operator/feedback/bulk-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, status: newStatus }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setItems((prev) => prev.map((x) => (selected.has(x.id) ? { ...x, status: newStatus, reviewedAt: new Date().toISOString() } : x)));
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      {stats && (
        <div className="flex flex-wrap gap-2 text-sm">
          <StatChip label="Open" value={stats.open} tone="warn" />
          <StatChip label="New (24h)" value={stats.last24h} tone="warn" />
          <StatChip label="Complaints" value={stats.complaints} />
          <StatChip label="Suggestions" value={stats.suggestions} />
          <StatChip label="Resolved" value={stats.resolved} />
          <StatChip label="Total" value={stats.total} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <Button key={f.value || "all"} size="sm" variant={status === f.value ? "default" : "outline"} onClick={() => changeStatus(f.value)}>
            {f.label}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        {KIND_FILTERS.map((f) => (
          <Button key={f.value || "allkinds"} size="sm" variant={kind === f.value ? "secondary" : "outline"} onClick={() => changeKind(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" disabled={busy} onClick={() => void bulk("RESOLVED")}>
            Resolve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk("DISMISSED")}>
            Dismiss
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No feedback{status ? ` with status ${status}` : ""} yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((f) => (
            <FeedbackRow key={f.id} item={f} selected={selected.has(f.id)} onToggle={() => toggle(f.id)} onReviewed={patchLocal} />
          ))}
        </ul>
      )}

      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(status, kind, cursor, true)}>
          {busy ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 " +
        (tone === "warn" && value > 0 ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "text-muted-foreground")
      }
    >
      <span className="font-semibold tabular-nums text-foreground">{value.toLocaleString()}</span>
      {label}
    </span>
  );
}

function FeedbackRow({
  item,
  selected,
  onToggle,
  onReviewed,
}: {
  item: Item;
  selected: boolean;
  onToggle: () => void;
  onReviewed: (updated: Item) => void;
}) {
  const [note, setNote] = React.useState(item.reviewNote ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [threadOpen, setThreadOpen] = React.useState(false);

  const review = async (status: FeedbackStatus) => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/operator/feedback/${item.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note: note || null }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    onReviewed({ ...item, status, reviewNote: note || null, reviewedAt: new Date().toISOString() });
  };

  return (
    <li>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggle}
                className="mt-1 h-4 w-4 shrink-0"
                aria-label={`Select feedback: ${item.subject}`}
              />
              <div className="min-w-0">
                <p className="font-medium">{item.subject}</p>
                <p className="text-xs text-muted-foreground">
                  {item.kind === "SUGGESTION" ? "Suggestion" : "Complaint"} · {item.senderName} · {item.schoolName} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
            <Badge variant={STATUS_VARIANT[item.status] ?? "outline"}>{item.status}</Badge>
          </div>

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.body}</p>

          <button
            type="button"
            onClick={() => setThreadOpen((v) => !v)}
            className="text-sm font-medium text-primary underline"
          >
            {threadOpen ? "Hide conversation" : "View conversation & reply"}
          </button>
          {threadOpen && (
            <FeedbackThread feedbackId={item.id} basePath="/api/sms/operator/feedback" mySide="PLATFORM" />
          )}

          <div className="space-y-2 border-t pt-3">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder="Closing note (shown to the sender when you set a status)"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void review("REVIEWED")}>
                Mark reviewed
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void review("RESOLVED")}>
                Resolve
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void review("DISMISSED")}>
                Dismiss
              </Button>
              {err && <span className="text-sm text-destructive">{err}</span>}
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
