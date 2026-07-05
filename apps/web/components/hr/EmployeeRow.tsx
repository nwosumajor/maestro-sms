"use client";

// One employee row on the HR register, with an inline EDIT panel (hr.write) for
// fixing wrongly-entered employment data: job title, department, type, start
// date, status. Salary is DELIBERATELY absent — changing pay goes through the
// maker-checker salary flow (request → a different approver), never a quick edit.

import type { EmployeeDto, Serialized } from "@sms/types";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { money, shortDate, titleCase } from "@/lib/format";

type Employee = Serialized<EmployeeDto>;

export function EmployeeRow({ e, canWrite }: { e: Employee; canWrite: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    jobTitle: e.jobTitle ?? "",
    department: e.department ?? "",
    employmentType: e.employmentType ?? "FULL_TIME",
    startDate: e.startDate ? e.startDate.slice(0, 10) : "",
    status: e.status ?? "ACTIVE",
  });

  const save = async () => {
    if (!form.jobTitle || !form.startDate) {
      setMsg("Job title and start date are required.");
      return;
    }
    setBusy(true);
    setMsg(null);
    const res = await sendSms("PUT", `hr/employees/${e.userId}`, {
      jobTitle: form.jobTitle,
      department: form.department || null,
      employmentType: form.employmentType,
      startDate: form.startDate,
      status: form.status,
    });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      router.refresh();
    } else setMsg(res.error ?? "Request failed.");
  };

  const sel = "h-8 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <>
      <tr className="border-b border-border last:border-0">
        <td className="px-4 py-2.5 font-medium">
          <Link href={`/hr/staff/${e.userId}`} className="hover:underline">{e.user?.name ?? "—"}</Link>
        </td>
        <td className="px-4 py-2.5">{e.jobTitle}{e.department ? ` · ${e.department}` : ""}</td>
        <td className="px-4 py-2.5 text-muted-foreground">{titleCase(e.employmentType)}</td>
        <td className="px-4 py-2.5 text-muted-foreground">{shortDate(e.startDate)}</td>
        <td className="px-4 py-2.5">{e.salaryMinor != null ? money(e.salaryMinor) : "—"}</td>
        <td className="px-4 py-2.5"><Badge variant={e.status === "ACTIVE" ? "secondary" : "outline"}>{titleCase(e.status)}</Badge></td>
        {canWrite && (
          <td className="px-4 py-2.5">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing((v) => !v); setMsg(null); }}>
              {editing ? "Close" : "Edit"}
            </Button>
          </td>
        )}
      </tr>
      {editing && (
        <tr className="border-b border-border bg-muted/40">
          <td colSpan={canWrite ? 7 : 6} className="px-4 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs font-medium">Job title
                <Input className="h-8" value={form.jobTitle} onChange={(ev) => setForm({ ...form, jobTitle: ev.target.value })} />
              </label>
              <label className="space-y-1 text-xs font-medium">Department
                <Input className="h-8" value={form.department} onChange={(ev) => setForm({ ...form, department: ev.target.value })} />
              </label>
              <label className="space-y-1 text-xs font-medium">Type
                <select className={sel} value={form.employmentType} onChange={(ev) => setForm({ ...form, employmentType: ev.target.value })}>
                  <option value="FULL_TIME">Full-time</option><option value="PART_TIME">Part-time</option><option value="CONTRACT">Contract</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">Start date
                <Input className="h-8" type="date" value={form.startDate} onChange={(ev) => setForm({ ...form, startDate: ev.target.value })} />
              </label>
              <label className="space-y-1 text-xs font-medium">Status
                <select className={sel} value={form.status} onChange={(ev) => setForm({ ...form, status: ev.target.value })}>
                  <option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="EXITED">Exited</option>
                </select>
              </label>
              <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</Button>
              <p className="w-full text-xs text-muted-foreground">
                Salary is not editable here — pay changes go through the salary request &amp; approval flow below (maker-checker).
              </p>
              {msg && <p className="w-full text-xs text-muted-foreground">{msg}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
