"use client";

import type { UserSummaryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { personLabel } from "@/lib/people";
import { useFormat } from "@/components/shell/RegionProvider";

type User = Serialized<UserSummaryDto>;

export function EmployeeForm({ users, managers = [] }: { users: User[]; managers?: { userId: string; name: string }[] }) {
  // The SCHOOL's currency — a salary typed in francs was stored a hundredfold.
  const { minorFrom } = useFormat();
  const router = useRouter();
  const [userId, setUserId] = React.useState(users[0]?.id ?? "");
  const [jobTitle, setJobTitle] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [employmentType, setEmploymentType] = React.useState("FULL_TIME");
  const [startDate, setStartDate] = React.useState("");
  const [salaryMajor, setSalaryMajor] = React.useState("");
  const [tin, setTin] = React.useState("");
  const [rsaPin, setRsaPin] = React.useState("");
  const [managerId, setManagerId] = React.useState("");
  // HOW LONG THEY ARE ON PROBATION, if they are.
  //
  // `employee.confirmationStatus` DEFAULTS TO "CONFIRMED", and `probationMonths`
  // — the only thing that sets it to PROBATION — was accepted by the API and
  // sent by no screen. So every member of staff created through the product was
  // recorded as a confirmed employee, which nobody chose; and because
  // `requestEmploymentChange` refuses a CONFIRMATION for anyone not on
  // PROBATION, the confirmation half of the employment lifecycle was
  // unreachable for every employee a school actually creates.
  //
  // Blank = already confirmed, which is the right default for the common case
  // of recording existing staff when a school comes onto the platform.
  const [probationMonths, setProbationMonths] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !jobTitle || !startDate) return;
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/hr/employees/${userId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobTitle, department: department || null, employmentType, startDate,
        salaryMinor: salaryMajor ? minorFrom(salaryMajor) : null,
        tin: tin.trim() || null,
        rsaPin: rsaPin.trim() || null,
        managerId: managerId || null,
        // Omitted, not zero: the API treats a number > 0 as "start a probation"
        // and anything else as "leave the status alone", and this field is only
        // honoured when the record is CREATED — changing it afterwards is what
        // the confirmation flow is for.
        ...(probationMonths ? { probationMonths: Number(probationMonths) } : {}),
      }),
    });
    setBusy(false);
    if (res.ok) { setJobTitle(""); setDepartment(""); setSalaryMajor(""); setProbationMonths(""); setMsg("Saved."); router.refresh(); }
    else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Add / update employee record</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="hr-user">Staff member</Label>
            <select id="hr-user" value={userId} onChange={(e) => setUserId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {users.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="hr-title">Job title</Label><Input id="hr-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Class Teacher" /></div>
          <div className="space-y-1.5"><Label htmlFor="hr-dept">Department</Label><Input id="hr-dept" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Primary" /></div>
          <div className="space-y-1.5">
            <Label htmlFor="hr-type">Type</Label>
            <select id="hr-type" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="FULL_TIME">Full-time</option><option value="PART_TIME">Part-time</option><option value="CONTRACT">Contract</option>
            </select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="hr-start">Start date</Label><Input id="hr-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="hr-probation">Probation <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <select
              id="hr-probation"
              value={probationMonths}
              onChange={(e) => setProbationMonths(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">No probation — already confirmed</option>
              {[3, 6, 9, 12, 18, 24].map((m) => (
                <option key={m} value={m}>
                  {m} months
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Only applies when the record is first created. Confirming them later is a separate,
              two-person step on their staff page.
            </p>
          </div>
          <div className="space-y-1.5"><Label htmlFor="hr-salary">Salary (₦)</Label><Input id="hr-salary" inputMode="decimal" value={salaryMajor} onChange={(e) => setSalaryMajor(e.target.value)} className="w-28" /></div>
          <div className="space-y-1.5"><Label htmlFor="hr-tin">TIN</Label><Input id="hr-tin" value={tin} onChange={(e) => setTin(e.target.value)} className="w-32" placeholder="tax id" /></div>
          <div className="space-y-1.5"><Label htmlFor="hr-rsa">RSA PIN</Label><Input id="hr-rsa" value={rsaPin} onChange={(e) => setRsaPin(e.target.value)} className="w-32" placeholder="pension" /></div>
          <div className="space-y-1.5">
            <Label htmlFor="hr-mgr">Reports to</Label>
            <select id="hr-mgr" value={managerId} onChange={(e) => setManagerId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">— nobody (top) —</option>
              {managers.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={busy}>Save</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </form>
      </CardContent>
    </Card>
  );
}
