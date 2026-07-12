"use client";

// =============================================================================
// LoansAdmin — school-wide staff loans (HR view) with maker-checker decisions
// =============================================================================
// hr.read sees every loan; a PENDING one is decided by a holder of
// hr.salary.approve who is NOT the requester (the API enforces both, plus
// STEP-UP re-auth via postWithStepUp — it's money). Recovery happens only
// through finalized payroll runs; the balance column tracks it.
// =============================================================================

import type { Serialized, StaffLoanDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Loan = Serialized<StaffLoanDto>;

const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ACTIVE: "default",
  PENDING: "secondary",
  SETTLED: "outline",
  REJECTED: "destructive",
};

export function LoansAdmin({ initial, canApprove }: { initial: Loan[]; canApprove: boolean }) {
  const router = useRouter();
  const [loans, setLoans] = React.useState<Loan[]>(initial);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setErr(null);
    const res = await postWithStepUp(`hr/loans/${id}/decide`, { approve });
    setBusy(null);
    if (res.ok) {
      const r = await fetch(`/api/sms/hr/loans`);
      if (r.ok) setLoans((await r.json()) as Loan[]);
      router.refresh();
    } else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(j?.message ?? `Failed (${res.status}).`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Staff loans &amp; advances</CardTitle>
        <CardDescription>
          Requests come from staff self-service; approval needs a different person (step-up). Repayments are
          recovered automatically by each finalized payroll run.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No loan requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1.5 pr-2">Staff</th>
                  <th className="px-2">Purpose</th>
                  <th className="px-2">Principal</th>
                  <th className="px-2">Monthly</th>
                  <th className="px-2">Balance</th>
                  <th className="px-2">Status</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{l.userName ?? "Staff"}</td>
                    <td className="px-2">{l.purpose}</td>
                    <td className="px-2 tabular-nums">{naira(l.principalMinor)}</td>
                    <td className="px-2 tabular-nums">{naira(l.monthlyMinor)}</td>
                    <td className="px-2 tabular-nums">{naira(l.balanceMinor)}</td>
                    <td className="px-2">
                      <Badge variant={STATUS_VARIANT[l.status] ?? "outline"}>{l.status.toLowerCase()}</Badge>
                    </td>
                    <td className="px-2 text-right">
                      {canApprove && l.status === "PENDING" && (
                        <span className="inline-flex gap-1">
                          <Button size="sm" className="h-7" disabled={busy === l.id} onClick={() => decide(l.id, true)}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={busy === l.id}
                            onClick={() => decide(l.id, false)}
                          >
                            Reject
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
