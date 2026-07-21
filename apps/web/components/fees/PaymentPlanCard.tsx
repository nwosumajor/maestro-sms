"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { PaymentPlanDto, Serialized } from "@sms/types";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Plan = Serialized<PaymentPlanDto>;

const STATE_STYLE: Record<string, string> = {
  PAID: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  DUE: "bg-primary/15 text-primary",
  OVERDUE: "bg-destructive/15 text-destructive",
  UPCOMING: "bg-muted text-muted-foreground",
};

// Installment plan on an invoice: everyone sees the tranche schedule with
// derived states; finance staff can (re)set it. Tranches must sum to the
// invoice total — validated server-side, pre-checked here for a clear message.
export function PaymentPlanCard({
  invoiceId,
  totalMinor,
  currency,
  initial,
  canManage,
}: {
  invoiceId: string;
  totalMinor: number;
  currency: string;
  initial: Plan | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [rows, setRows] = React.useState<Array<{ dueDate: string; amount: string }>>([
    { dueDate: "", amount: "" },
    { dueDate: "", amount: "" },
  ]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const tranches = initial?.tranches ?? [];
  if (tranches.length === 0 && !canManage) return null;

  const submit = async () => {
    const parsed = rows
      .filter((r) => r.dueDate && r.amount)
      .map((r) => ({ dueDate: r.dueDate, amountMinor: Math.round(Number(r.amount) * 100) }));
    const sum = parsed.reduce((n, t) => n + t.amountMinor, 0);
    if (sum !== totalMinor) {
      setErr(`Tranches must sum to the invoice total (${money(totalMinor, currency)}); currently ${money(sum, currency)}.`);
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await sendSms("PUT", `invoices/${invoiceId}/plan`, { tranches: parsed });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      router.refresh();
    } else setErr(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Payment plan</CardTitle>
            <CardDescription>
              {tranches.length
                ? "Pay each part like any normal payment — partials count toward the schedule."
                : "Split this invoice into scheduled parts."}
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel" : tranches.length ? "Replace plan" : "Set plan"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {tranches.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {tranches.map((t) => (
                <tr key={t.seq} className="border-b border-border last:border-0">
                  <td className="py-2 text-muted-foreground">Part {t.seq}</td>
                  <td className="py-2">{shortDate(t.dueDate)}</td>
                  <td className="py-2 text-right">{money(t.amountMinor, currency)}</td>
                  <td className="py-2 pl-3 text-right">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[t.state]}`}>
                      {t.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editing && (
          <div className="space-y-2 rounded-md border p-3">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="date"
                  className="rounded-md border bg-background p-1.5 text-sm"
                  value={r.dueDate}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={`Amount (${currency})`}
                  className="w-40 rounded-md border bg-background p-1.5 text-sm"
                  value={r.amount}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-destructive"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setRows([...rows, { dueDate: "", amount: "" }])}>
                + Tranche
              </Button>
              <Button size="sm" disabled={busy} onClick={submit}>
                Save plan
              </Button>
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
