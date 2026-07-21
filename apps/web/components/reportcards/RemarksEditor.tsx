"use client";

import * as React from "react";
import type { AcademicSessionDto, ReportCardRemarkDto, Serialized } from "@sms/types";
import { sendSms } from "@/components/game/play-ui";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Report-card remarks + term-scoped PDF generation. A term picker drives both:
// the class-teacher remark (editable by the student's teacher/supervisor or
// staff), the head remark (staff-wide only), and a "generate for this term"
// button that folds the remarks into the PDF. canWrite gates the class-teacher
// box; canHead gates the head box; the server enforces both regardless.
export function RemarksEditor({
  studentId,
  sessions,
  canWrite,
  canHead,
}: {
  studentId: string;
  sessions: Serialized<AcademicSessionDto>[];
  canWrite: boolean;
  canHead: boolean;
}) {
  const terms = sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name })));
  const [termId, setTermId] = React.useState(terms.find((t) => t.isCurrent)?.id ?? terms[0]?.id ?? "");
  const [ct, setCt] = React.useState("");
  const [head, setHead] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!termId) return;
    const res = await fetch(`/api/sms/reportcards/${studentId}/remarks?termId=${termId}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as Serialized<ReportCardRemarkDto>;
      setCt(data.classTeacherRemark ?? "");
      setHead(data.headRemark ?? "");
    } else {
      setCt("");
      setHead("");
    }
  }, [termId, studentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async (kind: "class-teacher" | "head") => {
    setBusy(true);
    setMsg(null);
    const remark = kind === "class-teacher" ? ct : head;
    const res = await sendSms("PUT", `reportcards/${studentId}/remarks/${kind}`, { termId, remark });
    setBusy(false);
    setMsg(res.ok ? "Saved." : res.error ?? "Failed.");
  };

  const generate = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/reportcards/${studentId}/generate?termId=${termId}`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setMsg(await readApiError(res));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-card-${studentId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Report card generated.");
  };

  if (terms.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Set up an academic session and terms first (Timetable → academic calendar) to add report-card remarks.
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Report card &amp; remarks</CardTitle>
        <CardDescription>Pick a term, add remarks, then generate the PDF (remarks print on it).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground">Term</label>
          <select
            className="rounded-md border bg-background p-1.5 text-sm"
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
          >
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.sessionName} · {t.name}
                {t.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={busy || !termId} onClick={generate}>
            Generate report card (PDF)
          </Button>
        </div>

        {canWrite && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Class teacher's remark</label>
            <textarea
              className="w-full rounded-md border bg-background p-2 text-sm"
              rows={2}
              value={ct}
              onChange={(e) => setCt(e.target.value)}
              placeholder="e.g. A diligent student who participates well in class."
            />
            <Button size="sm" disabled={busy || !ct.trim()} onClick={() => save("class-teacher")}>
              Save class teacher's remark
            </Button>
          </div>
        )}

        {canHead && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Head's remark</label>
            <textarea
              className="w-full rounded-md border bg-background p-2 text-sm"
              rows={2}
              value={head}
              onChange={(e) => setHead(e.target.value)}
              placeholder="e.g. A commendable result — keep it up."
            />
            <Button size="sm" disabled={busy || !head.trim()} onClick={() => save("head")}>
              Save head's remark
            </Button>
          </div>
        )}

        {!canWrite && !canHead && (
          <div className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">
            {ct && (
              <p>
                <span className="font-medium text-foreground/70">Class teacher:</span> {ct}
              </p>
            )}
            {head && (
              <p>
                <span className="font-medium text-foreground/70">Head:</span> {head}
              </p>
            )}
            {!ct && !head && <p>No remarks recorded for this term yet.</p>}
          </div>
        )}

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
