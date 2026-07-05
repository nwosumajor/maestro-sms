"use client";

// The student's per-term subject prompt. Shows the subjects the school fixed on
// their class, lets them tick their offering and submit — the selection then
// travels supervisor -> school admin / head teacher before it takes effect in
// the grading system. Status (and any reviewer note) is shown; a rejected
// selection can be corrected and resubmitted.

import type { SubjectSelectionOptionsDto, Serialized } from "@sms/types";
import * as React from "react";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Options = Serialized<SubjectSelectionOptionsDto>;

const STATUS_LABEL: Record<string, string> = {
  PENDING_SUPERVISOR: "Awaiting your class supervisor",
  PENDING_ADMIN: "Awaiting school admin / head teacher",
  APPROVED: "Approved",
  REJECTED: "Rejected — adjust and resubmit",
};

export function SubjectPicker() {
  const [opts, setOpts] = React.useState<Options | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/subject-selections/options");
    if (!r.ok) return;
    const data = (await r.json()) as Options;
    setOpts(data);
    setPicked(new Set(data.selection?.subjects.map((s) => s.id) ?? []));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (!opts) return null;
  if (!opts.termId || !opts.classId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subject selection</CardTitle>
          <CardDescription>
            {!opts.termId
              ? "No current term is set yet — subject selection opens once the school sets the academic calendar."
              : "You are not enrolled in a class yet."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const sel = opts.selection;
  const locked = sel != null && sel.status !== "REJECTED";
  const toggle = (id: string) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const submit = async () => {
    if (picked.size === 0) { setMsg("Pick at least one subject."); return; }
    setBusy(true); setMsg(null);
    const res = await sendSms("POST", "subject-selections", { termId: opts.termId, subjectIds: [...picked] });
    setBusy(false);
    if (res.ok) { setMsg("Submitted — your class supervisor will review it first."); load(); }
    else setMsg(res.error ?? `Submission failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">
            {sel ? "Your subjects" : "Choose your subjects"} — {opts.termName} · {opts.className}
          </CardTitle>
          <CardDescription>
            {sel
              ? STATUS_LABEL[sel.status] ?? sel.status
              : "Pick every subject you will offer this term. Your class supervisor and then the school admin or head teacher must approve before they count."}
          </CardDescription>
        </div>
        {sel && (
          <Badge variant={sel.status === "APPROVED" ? "default" : sel.status === "REJECTED" ? "destructive" : "secondary"}>
            {sel.status.replace(/_/g, " ")}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {sel?.reviewNote && (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Reviewer note: {sel.reviewNote}
          </p>
        )}
        {opts.offered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subjects have been fixed on your class yet — the school admin or principal sets them first.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {opts.offered.map((o) => (
              <label key={o.subjectId} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${picked.has(o.subjectId) ? "border-primary bg-primary/[0.06]" : "border-border"} ${locked ? "cursor-default opacity-80" : ""}`}>
                <input
                  type="checkbox"
                  checked={picked.has(o.subjectId)}
                  disabled={locked || busy}
                  onChange={() => toggle(o.subjectId)}
                  className="accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="font-medium">{o.subjectName}</span>
                  <span className="block text-xs text-muted-foreground">{o.teacherName}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {!locked && opts.offered.length > 0 && (
          <Button disabled={busy} onClick={submit}>
            {sel?.status === "REJECTED" ? "Resubmit selection" : "Submit for approval"}
          </Button>
        )}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
