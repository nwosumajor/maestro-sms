"use client";

// The mismatch list with its one correction per row. A row corrected here stays
// on screen saying what changed (and who was told) until the page is refreshed,
// rather than vanishing — a disappearing row reads as "it was never there".

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LedgerMismatchDto, LedgerRederiveResultDto, Serialized } from "@sms/types";
import { LEDGER_MISMATCH_LABELS } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { readJson } from "@/lib/read-json";
import { money, shortDate } from "@/lib/format";

const words = (s: string) => s.replace(/_/g, " ").toLowerCase();

export function LedgerMismatchTable({ rows }: { rows: Serialized<LedgerMismatchDto>[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Record<string, string>>({});

  const rederive = async (r: Serialized<LedgerMismatchDto>) => {
    setBusy(r.invoiceId);
    try {
      const res = await sendWithStepUp("POST", `operator/ledger-integrity/${r.invoiceId}/rederive`);
      if (res.ok) {
        const out = await readJson<LedgerRederiveResultDto>(res);
        setDone((d) => ({
          ...d,
          [r.invoiceId]: out
            ? `Corrected to ${words(out.to)}. ${out.notified} finance ${out.notified === 1 ? "person" : "people"} told.`
            : "Corrected.",
        }));
        router.refresh();
      } else {
        const why = await readApiError(res);
        setDone((d) => ({ ...d, [r.invoiceId]: why }));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">School</th>
            <th className="px-4 py-2 font-medium">Invoice</th>
            <th className="px-4 py-2 font-medium">Problem</th>
            <th className="px-4 py-2 text-right font-medium">Total</th>
            <th className="px-4 py-2 text-right font-medium">Paid (net)</th>
            <th className="px-4 py-2 font-medium">Says → should say</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.invoiceId} className="border-b last:border-0 align-top">
              <td className="px-4 py-2.5">{r.schoolName}</td>
              <td className="px-4 py-2.5">
                <div className="font-mono text-xs">{r.reference}</div>
                <div className="text-xs text-muted-foreground">last changed {shortDate(r.updatedAt)}</div>
              </td>
              <td className="px-4 py-2.5">
                <Badge variant={r.kind === "PARTIAL_MISLABELLED" ? "outline" : "destructive"}>{LEDGER_MISMATCH_LABELS[r.kind]}</Badge>
              </td>
              <td className="tnum px-4 py-2.5 text-right">{money(r.totalMinor, r.currency)}</td>
              <td className="tnum px-4 py-2.5 text-right">{money(r.netPaidMinor, r.currency)}</td>
              <td className="px-4 py-2.5">
                {words(r.status)} → <span className="font-medium">{words(r.derivedStatus)}</span>
              </td>
              <td className="px-4 py-2.5 text-right">
                {done[r.invoiceId] ? (
                  <span className="text-xs text-muted-foreground" role="status">
                    {done[r.invoiceId]}
                  </span>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => rederive(r)}>
                    {busy === r.invoiceId ? "Correcting…" : "Correct status"}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
