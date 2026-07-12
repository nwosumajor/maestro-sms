"use client";

// =============================================================================
// MyCompensation — staff self-service: my payslips + my loans (client island)
// =============================================================================
// Payslips list FINALIZED runs only; the PDF downloads through the BFF (the API
// self-scopes to the caller). Loan requests are maker-checker: this only files a
// PENDING request — someone else with hr.salary.approve decides.
// =============================================================================

import type { MyPayslipDto, Serialized, StaffLoanDto } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Slip = Serialized<MyPayslipDto>;
type Loan = Serialized<StaffLoanDto>;

const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false as const, error };
}

export function MyCompensation({ slips, loans: initialLoans }: { slips: Slip[]; loans: Loan[] }) {
  const [loans, setLoans] = React.useState<Loan[]>(initialLoans);
  const [principal, setPrincipal] = React.useState("");
  const [monthly, setMonthly] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function requestLoan() {
    const pMinor = Math.round(Number(principal) * 100);
    const mMinor = Math.round(Number(monthly) * 100);
    if (!(pMinor > 0) || !(mMinor > 0) || !purpose.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const r = await req("POST", `/hr/loans`, { principalMinor: pMinor, monthlyMinor: mMinor, purpose: purpose.trim() });
    setBusy(false);
    if (r.ok) {
      setPrincipal("");
      setMonthly("");
      setPurpose("");
      setMsg("Request filed — it goes to HR for approval.");
      const l = await req("GET", `/hr/loans/me`);
      if (l.ok) setLoans(l.data as Loan[]);
    } else setErr(r.error);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">My payslips</CardTitle>
          <CardDescription>Finalized payroll periods — download any slip as a PDF.</CardDescription>
        </CardHeader>
        <CardContent>
          {slips.length === 0 ? (
            <p className="text-sm text-muted-foreground">No finalized payslips yet.</p>
          ) : (
            <ul className="space-y-1">
              {slips.map((s) => (
                <li key={s.runId} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  <span className="font-medium">
                    {MONTHS[s.periodMonth]} {s.periodYear}
                  </span>
                  <span className="text-muted-foreground">
                    gross {s.grossMinor !== null ? naira(s.grossMinor) : "—"} · net{" "}
                    {s.netMinor !== null ? naira(s.netMinor) : "—"}
                  </span>
                  <a
                    className="ml-auto text-sm underline underline-offset-2"
                    href={`/api/sms/hr/payroll/me/payslips/${s.runId}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    PDF
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My loans &amp; advances</CardTitle>
          <CardDescription>
            Request a salary advance — HR approves, and repayment comes off each month’s pay automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              className="w-32"
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount ₦"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
            />
            <Input
              className="w-32"
              type="number"
              min="0"
              step="0.01"
              placeholder="Monthly ₦"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
            <Input className="w-44" placeholder="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            <Button size="sm" onClick={requestLoan} disabled={busy}>
              Request
            </Button>
          </div>

          {loans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No loans yet.</p>
          ) : (
            <ul className="space-y-1">
              {loans.map((l) => (
                <li key={l.id} className="rounded-md border px-3 py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{l.purpose}</span>
                    <Badge
                      variant={
                        l.status === "ACTIVE" ? "default" : l.status === "PENDING" ? "secondary" : l.status === "REJECTED" ? "destructive" : "outline"
                      }
                    >
                      {l.status.toLowerCase()}
                    </Badge>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {naira(l.balanceMinor)} of {naira(l.principalMinor)} left
                    </span>
                  </div>
                  {l.repayments && l.repayments.length > 0 && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Repaid: {l.repayments.map((r) => `${r.period} ${naira(r.amountMinor)}`).join(" · ")}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
