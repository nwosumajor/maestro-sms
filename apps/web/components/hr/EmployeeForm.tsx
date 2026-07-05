"use client";

import type { UserSummaryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type User = Serialized<UserSummaryDto>;

export function EmployeeForm({ users }: { users: User[] }) {
  const router = useRouter();
  const [userId, setUserId] = React.useState(users[0]?.id ?? "");
  const [jobTitle, setJobTitle] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [employmentType, setEmploymentType] = React.useState("FULL_TIME");
  const [startDate, setStartDate] = React.useState("");
  const [salaryMajor, setSalaryMajor] = React.useState("");
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
        salaryMinor: salaryMajor ? Math.round(parseFloat(salaryMajor) * 100) : null,
      }),
    });
    setBusy(false);
    if (res.ok) { setJobTitle(""); setDepartment(""); setSalaryMajor(""); setMsg("Saved."); router.refresh(); }
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
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
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
          <div className="space-y-1.5"><Label htmlFor="hr-salary">Salary (₦)</Label><Input id="hr-salary" inputMode="decimal" value={salaryMajor} onChange={(e) => setSalaryMajor(e.target.value)} className="w-28" /></div>
          <Button type="submit" disabled={busy}>Save</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </form>
      </CardContent>
    </Card>
  );
}
