"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { EmployeeDto, SalaryChangeDto, Serialized } from "@sms/types";
import { postWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

type Employee = Serialized<EmployeeDto>;
type Change = Serialized<SalaryChangeDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  PENDING: "secondary",
  APPROVED: "default",
  REJECTED: "destructive",
};

export function SalaryChanges({
  employees,
  changes,
  canRequest,
  canApprove,
  userId,
}: {
  employees: Employee[];
  changes: Change[];
  canRequest: boolean;
  canApprove: boolean;
  userId: string;
}) {
  const router = useRouter();
  const [employeeId, setEmployeeId] = React.useState(employees[0]?.id ?? "");
  const [salaryMajor, setSalaryMajor] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId || !salaryMajor) return;
    setBusy("request");
    setMsg(null);
    const res = await postWithStepUp(`hr/salary/employees/${employeeId}/changes`, {
      newSalaryMinor: Math.round(parseFloat(salaryMajor) * 100),
      reason: reason || null,
    });
    setBusy(null);
    if (res.ok) { setSalaryMajor(""); setReason(""); setMsg("Requested — needs a different HR approver."); router.refresh(); }
    else setMsg(`Failed (${res.status}).`);
  };

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setMsg(null);
    const res = await postWithStepUp(`hr/salary/changes/${id}/decide`, { approve });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(res.status === 403 ? "A salary change must be approved by someone other than the requester." : `Failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Salary changes (approval + history)</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {canRequest && (
          <form onSubmit={request} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="sc-emp">Employee</Label>
              <select id="sc-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.user?.name ?? emp.jobTitle}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="sc-salary">New salary (₦)</Label><Input id="sc-salary" inputMode="decimal" value={salaryMajor} onChange={(e) => setSalaryMajor(e.target.value)} className="w-32" /></div>
            <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="sc-reason">Reason</Label><Input id="sc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></div>
            <Button type="submit" disabled={busy === "request"}>Request change</Button>
          </form>
        )}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No salary changes yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr><th className="px-2 py-2 font-medium">Employee</th><th className="px-2 py-2 font-medium">From → To</th><th className="px-2 py-2 font-medium">Status</th><th className="px-2 py-2 font-medium" /></tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-2 py-2">{c.employeeName ?? "—"}</td>
                  <td className="px-2 py-2 text-muted-foreground">{c.oldSalaryMinor != null ? money(c.oldSalaryMinor) : "—"} → {c.newSalaryMinor != null ? money(c.newSalaryMinor) : "—"}</td>
                  <td className="px-2 py-2"><Badge variant={VARIANT[c.status] ?? "secondary"}>{c.status}</Badge></td>
                  <td className="px-2 py-2">
                    {canApprove && c.status === "PENDING" && c.requestedById !== userId && (
                      <span className="flex gap-2">
                        <Button size="sm" disabled={busy === c.id} onClick={() => decide(c.id, true)}>Approve</Button>
                        <Button size="sm" variant="destructive" disabled={busy === c.id} onClick={() => decide(c.id, false)}>Reject</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
