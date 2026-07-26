"use client";

import * as React from "react";
import type { PageDto, PlatformFeedbackDto, FeedbackStatus, Serialized } from "@sms/types";
import { FEEDBACK_STATUSES } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Item = Serialized<PlatformFeedbackDto>;
type Page = Serialized<PageDto<PlatformFeedbackDto>>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  OPEN: "outline",
  REVIEWED: "secondary",
  RESOLVED: "default",
  DISMISSED: "destructive",
};

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  ...FEEDBACK_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })),
];

export function FeedbackInbox({ initial }: { initial: Page }) {
  const [items, setItems] = React.useState<Item[]>(initial.items);
  const [cursor, setCursor] = React.useState<string | null>(initial.nextCursor);
  const [status, setStatus] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async (nextStatus: string, nextCursor: string | null, append: boolean) => {
    setBusy(true);
    setErr(null);
    const qs = new URLSearchParams({ limit: "25" });
    if (nextStatus) qs.set("status", nextStatus);
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
  }, []);

  const changeFilter = (s: string) => {
    setStatus(s);
    void load(s, null, false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.value || "all"} size="sm" variant={status === f.value ? "default" : "outline"} onClick={() => changeFilter(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No feedback{status ? ` with status ${status}` : ""} yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((f) => (
            <FeedbackRow key={f.id} item={f} onReviewed={(updated) => setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))} />
          ))}
        </ul>
      )}

      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(status, cursor, true)}>
          {busy ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

function FeedbackRow({ item, onReviewed }: { item: Item; onReviewed: (updated: Item) => void }) {
  const [note, setNote] = React.useState(item.reviewNote ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

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
            <div className="min-w-0">
              <p className="font-medium">{item.subject}</p>
              <p className="text-xs text-muted-foreground">
                {item.kind === "SUGGESTION" ? "Suggestion" : "Complaint"} · {item.senderName} · {item.schoolName} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[item.status] ?? "outline"}>{item.status}</Badge>
          </div>

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.body}</p>

          <div className="space-y-2 border-t pt-3">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder="Optional reply / internal note (visible to the sender)"
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
