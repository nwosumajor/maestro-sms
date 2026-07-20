"use client";

// One school's row on the message-credit oversight panel: balance + lifetime
// totals, an on-demand ledger drill-down, and (platform.subscription.manage
// only) a comp/debit form. Mirrors SubscriptionManager's expand-on-demand shape.

import type { MessageCreditBalanceDto, MessageCreditLedgerEntryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { dateTime } from "@/lib/format";
import { readApiError } from "@/lib/api-error";
import { sendWithStepUp } from "@/lib/stepup";

type Row = Serialized<MessageCreditBalanceDto>;
type Entry = Serialized<MessageCreditLedgerEntryDto>;

const REASON_LABEL: Record<string, string> = { PURCHASE: "Purchase", SEND: "Sent", ADJUST: "Operator comp/debit" };

export function MessageCreditRow({ row, canAdjust }: { row: Row; canAdjust: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [ledger, setLedger] = React.useState<Entry[] | null>(null);
  const [delta, setDelta] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && ledger === null) {
      setLoading(true);
      const res = await fetch(`/api/sms/operator/message-credits/${row.schoolId}/ledger`);
      setLoading(false);
      if (res.ok) setLedger((await res.json()) as Entry[]);
      else setMsg(await readApiError(res));
    }
  };

  const submitAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    const d = Number(delta);
    if (!Number.isInteger(d) || d === 0) { setMsg("Enter a non-zero whole number of credits."); return; }
    if (!note.trim()) { setMsg("A reason note is required."); return; }
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("POST", `operator/message-credits/${row.schoolId}/adjust`, { delta: d, note: note.trim() });
    setBusy(false);
    if (res.ok) {
      setDelta("");
      setNote("");
      setLedger(null); // force a re-fetch on next open
      setMsg("Applied ✓");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <div className="rounded-lg border border-border/70">
      <div className="flex flex-wrap items-center gap-4 p-3">
        <div className="min-w-[10rem] flex-1">
          <p className="font-medium">{row.schoolName}</p>
        </div>
        <Stat label="Balance" value={row.balance} emphasize={row.balance <= 0} />
        <Stat label="Purchased" value={row.totalPurchased} />
        <Stat label="Sent" value={row.totalSent} />
        <Stat label="Comps/debits" value={row.totalAdjusted} />
        <Button size="sm" variant="outline" onClick={toggle}>{open ? "Hide" : "Details"}</Button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border/70 p-3">
          {loading && <p className="text-sm text-muted-foreground">Loading ledger…</p>}
          {ledger && (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-1 pr-3">When</th>
                    <th className="pb-1 pr-3">Type</th>
                    <th className="pb-1 pr-3">Channel</th>
                    <th className="pb-1 pr-3 text-right">Δ</th>
                    <th className="pb-1">Reference / note</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.length === 0 ? (
                    <tr><td colSpan={5} className="py-2 text-muted-foreground">No ledger entries yet.</td></tr>
                  ) : (
                    ledger.map((e) => (
                      <tr key={e.id} className="border-t border-border/50">
                        <td className="py-1 pr-3 text-xs text-muted-foreground">{dateTime(e.createdAt)}</td>
                        <td className="py-1 pr-3">
                          <Badge variant={e.reason === "ADJUST" ? "secondary" : "outline"}>{REASON_LABEL[e.reason] ?? e.reason}</Badge>
                        </td>
                        <td className="py-1 pr-3 text-muted-foreground">{e.channel ?? "—"}</td>
                        <td className={"py-1 pr-3 text-right tnum font-medium " + (e.deltaCredits < 0 ? "text-destructive" : "text-brand2")}>
                          {e.deltaCredits > 0 ? "+" : ""}{e.deltaCredits.toLocaleString()}
                        </td>
                        <td className="py-1 text-xs text-muted-foreground">{e.reference ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {canAdjust && (
            <form onSubmit={submitAdjust} className="flex flex-wrap items-end gap-2 border-t border-border/70 pt-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground" htmlFor={`delta-${row.schoolId}`}>Adjust by (± credits)</label>
                <Input
                  id={`delta-${row.schoolId}`}
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  placeholder="e.g. 500 or -100"
                  className="w-32"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground" htmlFor={`note-${row.schoolId}`}>Reason (required)</label>
                <Input
                  id={`note-${row.schoolId}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. goodwill comp — gateway outage"
                  className="w-72"
                />
              </div>
              <Button type="submit" size="sm" disabled={busy}>{busy ? "Applying…" : "Apply"}</Button>
            </form>
          )}
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className="min-w-[5.5rem] text-right">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={"tnum text-sm font-semibold " + (emphasize ? "text-destructive" : "")}>{value.toLocaleString()}</p>
    </div>
  );
}
