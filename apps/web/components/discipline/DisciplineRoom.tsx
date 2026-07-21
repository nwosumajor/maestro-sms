"use client";

// Discipline Room UI. Anyone files a complaint against a student/teacher; staff
// (canManage) assign resolvers, add action notes, and record a resolution. Filers
// see only their own complaints. (Evidence upload is API-ready; the manage console
// shows assignees, notes, and the recorded resolution.)

import type { DisciplineComplaintDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { personLabel } from "@/lib/people";

type Complaint = Serialized<DisciplineComplaintDto>;
type Person = { id: string; name: string; roles?: string[] };

const STATUS_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  OPEN: "secondary", IN_REVIEW: "secondary", RESOLVED: "outline", DISMISSED: "outline",
};

export function DisciplineRoom({
  complaints, staff, teachers, students, canManage,
}: {
  complaints: Complaint[]; staff: Person[]; teachers: Person[]; students: Person[]; canManage: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [subject, setSubject] = React.useState("");
  const [details, setDetails] = React.useState("");
  const [againstType, setAgainstType] = React.useState("STUDENT");
  // The "against" list follows the chosen type — students OR teachers, never mixed.
  const againstList = againstType === "STUDENT" ? students : teachers;
  const [against, setAgainst] = React.useState(students[0]?.id ?? "");
  const [note, setNote] = React.useState<Record<string, string>>({});
  const [assignee, setAssignee] = React.useState<Record<string, string>>({});

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">File a complaint</CardTitle><CardDescription>Reviewed by staff. No automatic penalty is applied.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 flex-1 min-w-60"><Label>Subject</Label><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <select
                value={againstType}
                onChange={(e) => {
                  const t = e.target.value;
                  setAgainstType(t);
                  setAgainst((t === "STUDENT" ? students : teachers)[0]?.id ?? "");
                }}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="STUDENT">Student</option><option value="TEACHER">Teacher</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Against</Label>
              <select value={against} onChange={(e) => setAgainst(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {againstList.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5"><Label>Details</Label><Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} /></div>
          <Button disabled={busy || !subject || !against} onClick={() => run(() => postSms("discipline/complaints", { subject, details: details || undefined, againstId: against, againstType }), "Complaint filed.").then(() => { setSubject(""); setDetails(""); })}>Submit</Button>
        </CardContent>
      </Card>

      {complaints.length === 0 && <p className="text-sm text-muted-foreground">No complaints.</p>}

      {complaints.map((c) => (
        <Card key={c.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">{c.subject} <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>{c.status}</Badge></CardTitle>
            <CardDescription>Against {c.againstName} ({c.againstType.toLowerCase()}) · filed by {c.complainantName}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {c.details && <p className="text-sm">{c.details}</p>}
            {c.assignees.length > 0 && <div className="flex flex-wrap gap-2">{c.assignees.map((a) => <Badge key={a.id} variant="outline" className="font-normal">resolver: {a.assigneeName}</Badge>)}</div>}
            {c.evidence.length > 0 && <p className="text-xs text-muted-foreground">Evidence: {c.evidence.map((e) => e.fileName).join(", ")}</p>}
            {c.entries.map((e) => <p key={e.id} className="text-sm"><span className="font-medium">{e.authorName}:</span> {e.body}</p>)}
            {c.resolution && <p className="text-sm rounded-md border border-border p-2"><span className="font-medium">Resolution:</span> {c.resolution}</p>}

            {canManage && c.status !== "RESOLVED" && c.status !== "DISMISSED" && (
              <div className="space-y-2 border-t border-border pt-2">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Assign resolver</Label>
                    {/* Resolvers are staff — students never appear here. */}
                    <select value={assignee[c.id] ?? ""} onChange={(e) => setAssignee((m) => ({ ...m, [c.id]: e.target.value }))} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">Select…</option>
                      {staff.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
                    </select>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy || !assignee[c.id]} onClick={() => run(() => postSms(`discipline/complaints/${c.id}/assign`, { assigneeId: assignee[c.id] }), "Assigned.")}>Assign</Button>
                </div>
                <div className="flex gap-2">
                  <Input value={note[c.id] ?? ""} onChange={(e) => setNote((m) => ({ ...m, [c.id]: e.target.value }))} placeholder="Action note…" />
                  <Button size="sm" variant="outline" disabled={busy || !(note[c.id] ?? "").trim()} onClick={() => run(() => postSms(`discipline/complaints/${c.id}/entries`, { body: note[c.id] }), "Note added.").then(() => setNote((m) => ({ ...m, [c.id]: "" })))}>Add note</Button>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => postSms(`discipline/complaints/${c.id}/resolve`, { status: "RESOLVED", resolution: note[c.id] || "Resolved after review" }), "Resolved.")}>Mark resolved</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => postSms(`discipline/complaints/${c.id}/resolve`, { status: "DISMISSED", resolution: note[c.id] || "Dismissed" }), "Dismissed.")}>Dismiss</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
