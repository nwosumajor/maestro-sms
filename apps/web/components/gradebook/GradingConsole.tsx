"use client";

// Subject-teacher grading console. Pick a class → subject → term, then enter the
// four weighted components (exam 60 / midterm 20 / assignment 10 / class note 10)
// for each enrolled student. The weighted total is computed and shown live from
// the SAME pure engine the server uses, but the server RE-computes on save — the
// client figure is display-only. Publish makes a class-subject-term's grades
// visible to students and parents.

import type { GradingRosterDto, IdNameDto, AcademicSessionDto, Serialized } from "@sms/types";
import { GRADE_COMPONENTS, computeTermSubjectGrade } from "@sms/types";
import * as React from "react";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Named = Serialized<IdNameDto>;
type Session = Serialized<AcademicSessionDto>;
type Roster = Serialized<GradingRosterDto>;
type Offering = { subjectId: string; subjectName: string; teacherId: string; teacherName: string };
type Draft = { exam: string; midterm: string; assignment: string; classNote: string };

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

function toDraft(r: Roster["students"][number]): Draft {
  const v = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  return {
    exam: v(r.result?.exam),
    midterm: v(r.result?.midterm),
    assignment: v(r.result?.assignment),
    classNote: v(r.result?.classNote),
  };
}

function livePreview(d: Draft) {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const { total, grade, complete } = computeTermSubjectGrade({
    exam: num(d.exam), midterm: num(d.midterm), assignment: num(d.assignment), classNote: num(d.classNote),
  });
  const any = [d.exam, d.midterm, d.assignment, d.classNote].some((s) => s.trim() !== "");
  return any ? { total, grade, complete } : { total: null as number | null, grade: null as string | null, complete: false };
}

export function GradingConsole({ classes, sessions }: { classes: Named[]; sessions: Session[] }) {
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [offerings, setOfferings] = React.useState<Offering[]>([]);
  const [subjectId, setSubjectId] = React.useState("");
  const allTerms = sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name })));
  const defaultTerm = allTerms.find((t) => t.isCurrent) ?? allTerms[0];
  const [termId, setTermId] = React.useState(defaultTerm?.id ?? "");

  const [roster, setRoster] = React.useState<Roster | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Load a class's subject offerings when the class changes.
  React.useEffect(() => {
    if (!classId) return;
    let live = true;
    fetch(`/api/sms/classes/${classId}/subjects`)
      .then((r) => (r.ok ? r.json() : []))
      .then((subs: Offering[]) => {
        if (!live) return;
        setOfferings(subs);
        setSubjectId((cur) => (subs.some((s) => s.subjectId === cur) ? cur : subs[0]?.subjectId ?? ""));
      })
      .catch(() => live && setOfferings([]));
    return () => { live = false; };
  }, [classId]);

  const loadRoster = React.useCallback(async () => {
    if (!classId || !subjectId || !termId) { setRoster(null); return; }
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/term-results/roster?classId=${classId}&subjectId=${subjectId}&termId=${termId}`);
    setBusy(false);
    if (!res.ok) { setRoster(null); setMsg(res.status === 404 ? "You can't grade this subject, or it doesn't exist." : `Failed to load roster (${res.status}).`); return; }
    const data = (await res.json()) as Roster;
    setRoster(data);
    setDrafts(Object.fromEntries(data.students.map((s) => [s.studentId, toDraft(s)])));
  }, [classId, subjectId, termId]);

  React.useEffect(() => { loadRoster(); }, [loadRoster]);

  const setField = (studentId: string, key: keyof Draft, value: string) =>
    setDrafts((d) => ({ ...d, [studentId]: { ...d[studentId], [key]: value } }));

  const saveRow = async (studentId: string) => {
    const d = drafts[studentId];
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    setBusy(true); setMsg(null);
    const res = await sendSms("POST", "term-results", {
      termId, classId, subjectId, studentId,
      exam: num(d.exam), midterm: num(d.midterm), assignment: num(d.assignment), classNote: num(d.classNote),
    });
    setBusy(false);
    if (res.ok) { setMsg("Saved."); loadRoster(); } else setMsg(res.error ?? `Save failed (${res.status}).`);
  };

  const publish = async () => {
    if (!confirm("Submit these grades for publication? The head teacher and then the principal must approve before students and parents can see them.")) return;
    setBusy(true); setMsg(null);
    const res = await sendSms("POST", "term-results/publish", { classId, subjectId, termId });
    setBusy(false);
    if (res.ok) { setMsg("Submitted for approval — the grades go live once the head teacher and principal have both approved."); loadRoster(); }
    else setMsg(res.error ?? `Submission failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Grade a subject</CardTitle>
        <CardDescription>
          Weighting: {GRADE_COMPONENTS.map((c) => `${c.label} ${c.weight}%`).join(" · ")}. Totals compute automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className={sel}>
            {offerings.length === 0 && <option value="">No subjects offered</option>}
            {offerings.map((o) => <option key={o.subjectId} value={o.subjectId}>{o.subjectName}</option>)}
          </select>
          <select aria-label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} className={sel}>
            {allTerms.length === 0 && <option value="">No terms defined</option>}
            {allTerms.map((t) => <option key={t.id} value={t.id}>{t.sessionName} — {t.name}</option>)}
          </select>
        </div>

        {sessions.length === 0 && (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            No academic sessions or terms exist yet. An admin must create a session and its terms first (Admin → Academic calendar).
          </p>
        )}

        {roster && (
          <>
            <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2.5 font-medium">Student</th>
                    {GRADE_COMPONENTS.map((c) => (
                      <th key={c.key} className="px-2 py-2.5 font-medium">{c.label}<span className="text-muted-foreground/60"> /{c.weight}</span></th>
                    ))}
                    <th className="px-3 py-2.5 font-medium">Total</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {roster.students.map((s) => {
                    const d = drafts[s.studentId] ?? { exam: "", midterm: "", assignment: "", classNote: "" };
                    const pv = livePreview(d);
                    return (
                      <tr key={s.studentId} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-3 py-2">
                          <div className="font-medium">{s.studentName}</div>
                          {s.admissionNumber && <div className="text-xs text-muted-foreground">{s.admissionNumber}</div>}
                        </td>
                        {(["exam", "midterm", "assignment", "classNote"] as const).map((k) => (
                          <td key={k} className="px-2 py-2">
                            <Input type="number" min={0} max={100} value={d[k]} className="h-8 w-16 text-xs"
                              onChange={(e) => setField(s.studentId, k, e.target.value)} />
                          </td>
                        ))}
                        <td className="whitespace-nowrap px-3 py-2 font-medium">
                          {pv.total === null ? "—" : `${pv.total} (${pv.grade})`}
                          {!pv.complete && pv.total !== null && <span className="ml-1 text-xs text-muted-foreground">partial</span>}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className={s.result?.status === "PUBLISHED" ? "text-primary" : s.result?.status === "PENDING_APPROVAL" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}>
                            {s.result?.status === "PENDING_APPROVAL" ? "AWAITING APPROVAL" : s.result?.status ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => saveRow(s.studentId)}>Save</Button>
                        </td>
                      </tr>
                    );
                  })}
                  {roster.students.length === 0 && (
                    <tr><td colSpan={GRADE_COMPONENTS.length + 4} className="px-3 py-4 text-muted-foreground">No students enrolled in this class.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {roster.students.length > 0 && (
              <div className="space-y-1.5">
                <Button disabled={busy} onClick={publish}>Submit saved grades for publication</Button>
                <p className="text-xs text-muted-foreground">
                  Publication is approved in two stages — head teacher, then principal — before families can see the grades.
                  Grades awaiting approval are locked; editing an already-published grade sends it back through approval.
                </p>
              </div>
            )}
          </>
        )}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
