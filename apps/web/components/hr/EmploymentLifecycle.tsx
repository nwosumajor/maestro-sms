"use client";

// =============================================================================
// EmploymentLifecycle — probation/confirmation, promotion, contract renewal
// =============================================================================
// Maker-checker like salary changes: hr.write requests, a DIFFERENT person with
// hr.salary.approve decides (the API enforces both). The request history below
// IS the employment history. Promotions never move pay — that's the salary
// panel's maker-checker.
// =============================================================================

import type { EmployeeDto, EmploymentChangeDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Change = Serialized<EmploymentChangeDto>;
type Employee = Serialized<EmployeeDto>;

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

const dateStr = (v: string | Date | null) => (v ? new Date(v).toLocaleDateString(undefined, { dateStyle: "medium" }) : null);

export function EmploymentLifecycle({
  userId,
  employee,
  initial,
  canApprove,
}: {
  userId: string;
  employee: Employee | null;
  initial: Change[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [changes, setChanges] = React.useState<Change[]>(initial);
  const [type, setType] = React.useState("PROMOTION");
  const [newJobTitle, setNewJobTitle] = React.useState("");
  const [newGradeLevel, setNewGradeLevel] = React.useState("");
  const [newEndDate, setNewEndDate] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    const r = await req("GET", `/hr/employment/changes?userId=${userId}`);
    if (r.ok) setChanges(r.data as Change[]);
    router.refresh();
  }

  async function request() {
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/hr/employment/changes`, {
      userId,
      type,
      ...(type === "PROMOTION" ? { newJobTitle: newJobTitle || undefined, newGradeLevel: newGradeLevel || undefined } : {}),
      ...(type === "RENEWAL" ? { newEndDate } : {}),
    });
    setBusy(false);
    if (r.ok) {
      setNewJobTitle("");
      setNewGradeLevel("");
      setNewEndDate("");
      void refresh();
    } else setErr(r.error);
  }

  async function decide(id: string, approve: boolean) {
    setErr(null);
    const r = await req("POST", `/hr/employment/changes/${id}/decide`, { approve });
    if (r.ok) void refresh();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Employment status</CardTitle>
        <CardDescription>
          Confirmation, promotion and contract renewal go through a second approver — the request log below is
          the employment history. Pay changes stay in the salary panel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {employee && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={employee.confirmationStatus === "CONFIRMED" ? "default" : "secondary"}>
              {employee.confirmationStatus === "CONFIRMED" ? "confirmed" : "on probation"}
            </Badge>
            {employee.confirmationStatus === "PROBATION" && employee.probationEndsAt && (
              <span className="text-muted-foreground">probation ends {dateStr(employee.probationEndsAt)}</span>
            )}
            {employee.gradeLevel && <Badge variant="outline">{employee.gradeLevel}</Badge>}
            {employee.endDate ? (
              <span className="text-muted-foreground">contract ends {dateStr(employee.endDate)}</span>
            ) : (
              <span className="text-muted-foreground">open-ended</span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs">Change</Label>
            <select
              aria-label="Change type"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="PROMOTION">Promotion</option>
              <option value="CONFIRMATION">Confirm (end probation)</option>
              <option value="RENEWAL">Renew contract</option>
            </select>
          </div>
          {type === "PROMOTION" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">New title</Label>
                <Input className="w-40" value={newJobTitle} onChange={(e) => setNewJobTitle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">New grade</Label>
                <Input className="w-28" value={newGradeLevel} onChange={(e) => setNewGradeLevel(e.target.value)} placeholder="GL-09" />
              </div>
            </>
          )}
          {type === "RENEWAL" && (
            <div className="space-y-1">
              <Label className="text-xs">New end date</Label>
              <Input className="w-40" type="date" value={newEndDate} onChange={(e) => setNewEndDate(e.target.value)} />
            </div>
          )}
          <Button size="sm" onClick={request} disabled={busy}>
            Request
          </Button>
        </div>

        {changes.length > 0 && (
          <ul className="space-y-1">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <Badge variant={c.status === "APPROVED" ? "default" : c.status === "REJECTED" ? "destructive" : "secondary"}>
                  {c.status.toLowerCase()}
                </Badge>
                <span className="font-medium">{c.type.toLowerCase()}</span>
                <span className="text-muted-foreground">
                  {[c.newJobTitle, c.newGradeLevel, c.newEndDate ? `until ${dateStr(c.newEndDate)}` : null]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">{dateStr(c.createdAt)}</span>
                {canApprove && c.status === "PENDING" && (
                  <span className="inline-flex gap-1">
                    <Button size="sm" className="h-7" onClick={() => decide(c.id, true)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => decide(c.id, false)}>
                      Reject
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground">Official letters:</span>
          {[
            ["EMPLOYMENT", "Employment"],
            ["CONFIRMATION", "Confirmation"],
            ["PROMOTION", "Promotion"],
            ["EXPERIENCE", "Experience"],
          ].map(([type, label]) => (
            <a
              key={type}
              className="underline underline-offset-2"
              href={`/api/sms/hr/letters/${userId}/pdf?type=${type}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {label}
            </a>
          ))}
          <span className="text-xs text-muted-foreground">— letterhead PDF, issuance audited; salary never printed.</span>
        </div>
      </CardContent>
    </Card>
  );
}
