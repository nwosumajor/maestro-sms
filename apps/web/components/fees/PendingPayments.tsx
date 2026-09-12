"use client";

import type { PendingPaymentDto, PendingPaymentPageDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { titleCase } from "@/lib/format";
import { useFormat } from "@/components/shell/RegionProvider";
import { readApiError } from "@/lib/api-error";

export type PendingPayment = Serialized<PendingPaymentDto>;
export type PendingPage = Serialized<PendingPaymentPageDto>;

export function PendingPayments({ page }: {
  /** A PAGE, not an array. The queue was newest-first and capped at 200 with no
   *  count: on a five-year backlog of 901, 78% of the money awaiting a second
   *  signature was invisible and the families who had waited longest were the
   *  ones out of reach. */
  page: PendingPage;
}) {
  const payments = page.items;
  // The SCHOOL's currency, not the platform's. `money` from `@/lib/format`
  // defaults to `PLATFORM_REGION.currency`, so this rendered in naira whatever
  // the school bills in — the region rides the session and `useFormat()` is how
  // a client island reaches it.
  const { money, shortDate, dateTime } = useFormat();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (id: string, action: "approve" | "reject") => {
    setBusy(id); setMsg(null);
    const res = await fetch(`/api/sms/payments/${id}/${action}`, { method: "POST" });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(await readApiError(res, "You can't approve a payment you recorded."));
  };

  if (page.total === 0) return null;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="text-base">Payments awaiting your approval</CardTitle>
        <CardDescription>
          Large payments and all refunds need a second approver (separation of duties).
          {" "}
          {page.total > page.shown
            ? `Showing the ${page.shown} that have waited longest, of ${page.total} awaiting approval.`
            : `${page.total} awaiting approval.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={p.kind === "REFUND" ? "destructive" : "default"}>{titleCase(p.kind)}</Badge>
              <span className="font-medium">{money(p.amountMinor)}</span>
              <span className="text-muted-foreground">{titleCase(p.method)}</span>
              {/* HOW LONG IT HAS WAITED. The queue is worked oldest-first, and
                  that is only actionable if the approver can see the wait:
                  "recorded 14 months ago" and "recorded today" are different
                  decisions, and while it waits the family's invoice still shows
                  the balance they have already paid. */}
              <span className="text-xs text-muted-foreground" title={dateTime(p.createdAt)}>
                waiting since {shortDate(p.createdAt)}
              </span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, "approve")}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => act(p.id, "reject")}>Reject</Button>
            </div>
          </div>
        ))}
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
            {/* A cap is only safe when the rest is reachable. Oldest first, so
            page 1 is the longest-waiting — but the tail must still be openable. */}
        {page.total > page.pageSize && (
          <div className="flex items-center gap-3 px-4 pb-3 text-xs text-muted-foreground">
            {page.page > 1 && (
              <a className="underline hover:text-foreground" href={`/fees?pendingPage=${page.page - 1}`}>← longer waiting</a>
            )}
            <span>page {page.page} of {Math.max(1, Math.ceil(page.total / page.pageSize))}</span>
            {page.page * page.pageSize < page.total && (
              <a className="underline hover:text-foreground" href={`/fees?pendingPage=${page.page + 1}`}>more recent →</a>
            )}
          </div>
        )}
</Card>
  );
}
