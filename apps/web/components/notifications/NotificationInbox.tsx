"use client";

import type { NotificationInboxDto, NotificationItemDto, Serialized } from "@sms/types";
import { useFormat } from "@/components/shell/RegionProvider";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readApiError } from "@/lib/api-error";
import { titleCase } from "@/lib/format";

export type NotificationItem = Serialized<NotificationItemDto>;
export type InboxData = Serialized<NotificationInboxDto>;

const TYPE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  // Absence stays red — a child who did not arrive. Lateness is its own type
  // now and is a nudge, not an alarm.
  ATTENDANCE_ABSENCE: "destructive",
  ATTENDANCE_LATE: "secondary",
  INVOICE_ISSUED: "default",
  PAYMENT_RECEIVED: "secondary",
  DOCUMENT_AVAILABLE: "secondary",
  ANNOUNCEMENT: "default",
  OPERATOR_ALERT: "destructive",
};

/** Types rendered as RED alerts (destructive card frame, not just the badge). */
const ALERT_TYPES = new Set(["OPERATOR_ALERT"]);

/**
 * Types worth filtering by.
 *
 * NOT `NOTIFICATION_TYPES` from @sms/types: that union is knowingly incomplete
 * (its own comment says so) and omits OPERATOR_ALERT, BILLING and ONBOARDING —
 * which are exactly the ones the platform owner comes here to find. A filter
 * built from it would silently offer no way to ask the most useful question.
 */
const FILTERABLE_TYPES = [
  "OPERATOR_ALERT",
  "BILLING",
  "ONBOARDING",
  "ANNOUNCEMENT",
  "INVOICE_ISSUED",
  "PAYMENT_RECEIVED",
  "ATTENDANCE_ABSENCE",
  "ATTENDANCE_LATE",
  "DOCUMENT_AVAILABLE",
  "WORKFLOW_UPDATE",
  "GRADE_POSTED",
  "GENERIC",
];

export function NotificationInbox({ initial }: { initial: InboxData }) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { dateTime } = useFormat();
  const [data, setData] = React.useState(initial);
  const [items, setItems] = React.useState(initial.items);
  const [unread, setUnread] = React.useState(initial.unread);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState({ type: "", q: "", unreadOnly: false });
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);

  /**
   * Re-ask the SERVER, never narrow what is already on screen.
   *
   * Filtering the loaded page in the browser would search the page rather than
   * the inbox — so "OPERATOR_ALERT" would mean "operator alerts among the last
   * fifty arrivals" and quietly answer the wrong question. Same trap the
   * approvals register had.
   */
  const load = React.useCallback(async (next: { type: string; q: string; unreadOnly: boolean }, p: number) => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ page: String(p) });
    if (next.type) qs.set("type", next.type);
    if (next.q.trim()) qs.set("q", next.q.trim());
    if (next.unreadOnly) qs.set("unread", "1");
    const res = await fetch(`/api/sms/notifications?${qs}`);
    setLoading(false);
    if (!res.ok) {
      setError(await readApiError(res));
      return;
    }
    const d = (await res.json()) as InboxData;
    setData(d);
    setItems(d.items);
    setUnread(d.unread);
    setPage(d.page);
  }, []);

  const apply = (next: Partial<typeof filters>) => {
    const merged = { ...filters, ...next };
    setFilters(merged);
    void load(merged, 1);
  };

  const markRead = async (id: string) => {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/sms/notifications/${id}/read`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      setItems((xs) => xs.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnread((u) => Math.max(0, u - 1));
    } else {
      // This used to be an empty `if (res.ok)` with no else: the row simply
      // stayed highlighted and nothing was said, so a failure was
      // indistinguishable from a click that missed.
      setError(await readApiError(res));
    }
  };

  /**
   * ONE request, not one per notification.
   *
   * This looped `await markRead(n.id)` — a sequential round trip per row, so a
   * full inbox took dozens of latencies, and a failure halfway left some read
   * and some not with nothing on screen to say so.
   */
  const markAll = async () => {
    setBusy("all");
    setError(null);
    const res = await fetch("/api/sms/notifications/read-all", { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      setError(await readApiError(res));
      return;
    }
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    setUnread(0);
  };

  return (
    <div className="space-y-4">
      {/* FILTERS. The inbox used to be the most-recent hundred with no way to
          reach anything else — right for a queue, wrong for a record, and the
          platform owner's inbox is where "did anyone get told about that" is
          answered months later. */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Search
          <input
            className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            placeholder="Title or message"
            defaultValue={filters.q}
            onKeyDown={(e) => { if (e.key === "Enter") apply({ q: (e.target as HTMLInputElement).value }); }}
            onBlur={(e) => { if (e.target.value !== filters.q) apply({ q: e.target.value }); }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Type
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={filters.type}
            onChange={(e) => apply({ type: e.target.value })}
          >
            <option value="">All types</option>
            {FILTERABLE_TYPES.map((t) => (
              <option key={t} value={t}>{titleCase(t)}</option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant={filters.unreadOnly ? "default" : "outline"}
          onClick={() => apply({ unreadOnly: !filters.unreadOnly })}
        >
          Unread only
        </Button>
        {(filters.q || filters.type || filters.unreadOnly) && (
          <Button size="sm" variant="ghost" onClick={() => apply({ q: "", type: "", unreadOnly: false })}>
            Clear
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={unread > 0 ? "default" : "outline"}>
          {unread}{data.unreadIsCapped ? "+" : ""} unread
        </Badge>
        {error && <span className="text-xs text-destructive">{error}</span>}
        {unread > 0 && (
          <Button size="sm" variant="outline" onClick={markAll} disabled={busy === "all"}>
            Mark all read
          </Button>
        )}
      </div>

      {/* Say what is being SHOWN out of what MATCHES. A list that silently stops
          at the newest page reads as a complete answer. */}
      <p className="text-sm text-muted-foreground">
        {data.total === 0
          ? "Nothing matches."
          : `Showing ${(data.page - 1) * data.pageSize + 1}–${(data.page - 1) * data.pageSize + items.length} of ${data.total}${data.totalIsCapped ? "+" : ""}${filters.q || filters.type || filters.unreadOnly ? " matching" : ""}.`}
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filters.q || filters.type || filters.unreadOnly
            ? "Nothing matches that filter."
            : "No notifications yet."}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((n) => (
            <Card
              key={n.id}
              className={cn(
                !n.readAt && "border-primary/40 bg-primary/[0.03]",
                ALERT_TYPES.has(n.type) && "border-destructive/50 bg-destructive/[0.06]",
              )}
            >
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.readAt && (
                      <span
                        className={cn("h-2 w-2 shrink-0 rounded-full", ALERT_TYPES.has(n.type) ? "bg-destructive" : "bg-primary")}
                        aria-label="unread"
                      />
                    )}
                    <span className={cn("font-medium", ALERT_TYPES.has(n.type) && "text-destructive")}>{n.title}</span>
                    <Badge variant={TYPE_VARIANT[n.type] ?? "outline"}>{titleCase(n.type)}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{n.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{dateTime(n.createdAt)}</p>
                </div>
                {!n.readAt && (
                  <Button size="sm" variant="ghost" disabled={busy === n.id} onClick={() => markRead(n.id)}>
                    Mark read
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Paging runs off `hasMore`, not off the total — the count stops at its
          cap, and the inbox does not. */}
      {(page > 1 || data.hasMore) && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => void load(filters, page - 1)}>
            Newer
          </Button>
          <Button size="sm" variant="outline" disabled={!data.hasMore || loading} onClick={() => void load(filters, page + 1)}>
            Older
          </Button>
          <span className="text-xs text-muted-foreground">Page {page}</span>
        </div>
      )}
    </div>
  );
}
