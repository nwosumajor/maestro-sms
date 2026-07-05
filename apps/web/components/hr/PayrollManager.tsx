"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { PayrollRunDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import { readApiError } from "@/lib/api-error";

type Run = Serialized<PayrollRunDto>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function PayrollManager({ runs, canRun }: { runs: Run[]; canRun: boolean }) {
  const router = useRouter();
  const now = new Date();
  const [year, setYear] = React.useState(String(now.getUTCFullYear()));
  const [month, setMonth] = React.useState(String(now.getUTCMonth() + 1));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const call = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    setMsg(null);
    const res = await fetch(`/api/sms/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(res.status === 409 ? "A run already exists for that period." : await readApiError(res));
  };

  return (
    <div className="space-y-4">
      {canRun && (
        <Card>
          <CardHeader><CardTitle className="text-base">Run payroll</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5"><Label htmlFor="pr-year">Year</Label><Input id="pr-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} className="w-24" /></div>
              <div className="space-y-1.5">
                <Label htmlFor="pr-month">Month</Label>
                <select id="pr-month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <Button disabled={busy === "create"} onClick={() => call("hr/payroll/runs", { periodYear: parseInt(year, 10), periodMonth: parseInt(month, 10) }, "create")}>
                Generate draft
              </Button>
              {msg && <span className="text-sm text-destructive">{msg}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Payroll runs</CardTitle></CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Period</th><th className="px-4 py-2.5 font-medium">Staff</th><th className="px-4 py-2.5 font-medium">Gross</th><th className="px-4 py-2.5 font-medium">Net</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium" /></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{MONTHS[r.periodMonth - 1]} {r.periodYear}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.payslipCount}</td>
                    <td className="px-4 py-2.5">{money(r.totalGrossMinor)}</td>
                    <td className="px-4 py-2.5">{money(r.totalNetMinor)}</td>
                    <td className="px-4 py-2.5"><Badge variant={r.status === "FINALIZED" ? "default" : "secondary"}>{r.status}</Badge></td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3">
                        {canRun && r.status === "DRAFT" && (
                          <Button size="sm" disabled={busy === r.id} onClick={() => call(`hr/payroll/runs/${r.id}/finalize`, {}, r.id)}>Finalize</Button>
                        )}
                        {canRun && (
                          <a className="text-sm text-primary underline" href={`/api/sms/hr/payroll/runs/${r.id}/bank-export`}>Bank export</a>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
