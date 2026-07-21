"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { InvoiceAdjustmentDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Adjustment = Serialized<InvoiceAdjustmentDto>;

const STATUS_STYLE: Record<string, string> = {
  PENDING_APPROVAL: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  APPROVED: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  REJECTED: "bg-muted text-muted-foreground",
};

// Maker-checker discounts/waivers: fee.manage requests, a DIFFERENT
// fee.approve holder decides (the API enforces separation of duties — the
// requester's own Decide click comes back 403 with a clear message).
export function AdjustmentsPanel({
  invoiceId,
  currency,
  initial,
  canApprove,
  selfId,
}: {
  invoiceId: string;
  currency: string;
  initial: Adjustment[];
  canApprove: boolean;
  selfId: string;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<"DISCOUNT" | "WAIVER">("DISCOUNT");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const request = async () => {
    setBusy(true);
    setErr(null);
    const res = await postSms(`invoices/${invoiceId}/adjustments`, {
      kind,
      amountMinor: Math.round(Number(amount) * 100),
      reason: reason.trim(),
    });
    setBusy(false);
    if (res.ok) {
      setAmount("");
      setReason("");
      router.refresh();
    } else setErr(res.error ?? "Failed.");
  };

  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    setErr(null);
    const res = await postSms(`fees/adjustments/${id}/decide`, { approve });
    setBusy(false);
    if (res.ok) router.refresh();
    else setErr(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Discounts &amp; waivers</CardTitle>
        <CardDescription>
          Formal, approvable reductions — requested here, approved by a different staff member with approval rights.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {initial.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {initial.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="py-2">{a.kind === "WAIVER" ? "Waiver" : "Discount"}</td>
                  <td className="py-2 text-right">{money(a.amountMinor, currency)}</td>
                  <td className="max-w-[16rem] truncate py-2 pl-3 text-muted-foreground" title={a.reason}>
                    {a.reason}
                  </td>
                  <td className="py-2 pl-3 text-right text-muted-foreground">{shortDate(a.createdAt)}</td>
                  <td className="py-2 pl-3 text-right">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[a.status]}`}>
                      {a.status === "PENDING_APPROVAL" ? "PENDING" : a.status}
                    </span>
                  </td>
                  {canApprove && a.status === "PENDING_APPROVAL" && a.requestedById !== selfId && (
                    <td className="py-2 pl-3 text-right">
                      <span className="inline-flex gap-1.5">
                        <Button size="sm" disabled={busy} onClick={() => decide(a.id, true)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(a.id, false)}>
                          Reject
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
          <select
            className="rounded-md border bg-background p-1.5 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as "DISCOUNT" | "WAIVER")}
          >
            <option value="DISCOUNT">Discount</option>
            <option value="WAIVER">Waiver</option>
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder={`Amount (${currency})`}
            className="w-36 rounded-md border bg-background p-1.5 text-sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            placeholder="Reason (required)"
            className="min-w-48 flex-1 rounded-md border bg-background p-1.5 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" disabled={busy || !amount || reason.trim().length < 3} onClick={request}>
            Request
          </Button>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
