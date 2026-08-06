"use client";

import type { NotificationInboxDto, NotificationItemDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readApiError } from "@/lib/api-error";
import { dateTime, titleCase } from "@/lib/format";

export type NotificationItem = Serialized<NotificationItemDto>;
export type InboxData = Serialized<NotificationInboxDto>;

const TYPE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ATTENDANCE_ABSENCE: "destructive",
  INVOICE_ISSUED: "default",
  PAYMENT_RECEIVED: "secondary",
  DOCUMENT_AVAILABLE: "secondary",
  ANNOUNCEMENT: "default",
  OPERATOR_ALERT: "destructive",
};

/** Types rendered as RED alerts (destructive card frame, not just the badge). */
const ALERT_TYPES = new Set(["OPERATOR_ALERT"]);

export function NotificationInbox({ initial }: { initial: InboxData }) {
  const [items, setItems] = React.useState(initial.items);
  const [unread, setUnread] = React.useState(initial.unread);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

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
      <div className="flex items-center gap-3">
        <Badge variant={unread > 0 ? "default" : "outline"}>{unread} unread</Badge>
        {error && <span className="text-xs text-destructive">{error}</span>}
        {unread > 0 && (
          <Button size="sm" variant="outline" onClick={markAll} disabled={busy === "all"}>
            Mark all read
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notifications yet.</p>
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
    </div>
  );
}
