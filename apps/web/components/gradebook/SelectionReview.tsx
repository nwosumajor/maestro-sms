"use client";

// Staff review queue for student subject selections. The server scopes the
// list: a class supervisor sees selections naming them; school_admin /
// head_teacher / principal see all. Buttons only render for the stage the
// caller can actually act on (the API re-enforces identity + SoD).

import type { SubjectSelectionDto, Serialized } from "@sms/types";
import * as React from "react";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Selection = Serialized<SubjectSelectionDto>;

export function SelectionReview({ userId, canApproveFinal }: { userId: string; canApproveFinal: boolean }) {
  const [rows, setRows] = React.useState<Selection[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/subject-selections");
    if (r.ok) setRows((await r.json()) as Selection[]);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (!rows || rows.length === 0) return null;

  const actionable = (s: Selection) =>
    (s.status === "PENDING_SUPERVISOR" && s.supervisorId === userId) ||
    (s.status === "PENDING_ADMIN" && canApproveFinal);

  const act = async (s: Selection, action: "APPROVE" | "REJECT") => {
    const note = action === "REJECT" ? (prompt("Reason (shown to the student):") ?? undefined) : undefined;
    setBusy(s.id); setMsg(null);
    const res = await sendSms("POST", `subject-selections/${s.id}/review`, { action, note });
    setBusy(null);
    if (res.ok) load(); else setMsg(res.error ?? "Request failed.");
  };

  const pending = rows.filter((s) => s.status === "PENDING_SUPERVISOR" || s.status === "PENDING_ADMIN");
  const done = rows.filter((s) => s.status === "APPROVED" || s.status === "REJECTED").slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Subject selections</CardTitle>
        <CardDescription>
          Student subject choices for the term. Each passes the class supervisor, then the school
          admin or head teacher (a different person), before it takes effect in grading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing awaiting review.</p>}
        {[...pending, ...done].map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {s.studentName} <span className="text-muted-foreground">· {s.className} · {s.termName}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {s.subjects.map((x) => x.name).join(", ")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={s.status === "APPROVED" ? "default" : s.status === "REJECTED" ? "destructive" : "secondary"}>
                {s.status === "PENDING_SUPERVISOR" ? "supervisor" : s.status === "PENDING_ADMIN" ? "final approval" : s.status.toLowerCase()}
              </Badge>
              {actionable(s) && (
                <>
                  <Button size="sm" className="h-7 text-xs" disabled={busy === s.id} onClick={() => act(s, "APPROVE")}>Approve</Button>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={busy === s.id} onClick={() => act(s, "REJECT")}>Reject</Button>
                </>
              )}
            </div>
          </div>
        ))}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
