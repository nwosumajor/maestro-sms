"use client";

// Class supervisor / teacher score sheet: pick a class + term and see every
// student in the class down the side against every subject across the top — each
// cell the subject total + grade, plus each student's average and class position.
// Read-only; the server scopes it to the class supervisor / teachers / leadership
// (anyone else 404s) and recomputes every total server-side.

import type { ClassBroadsheetDto, IdNameDto, AcademicSessionDto, Serialized } from "@sms/types";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Named = Serialized<IdNameDto>;
type Session = Serialized<AcademicSessionDto>;
type Sheet = Serialized<ClassBroadsheetDto>;

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

function fmt(n: number | null): string {
  return n === null || n === undefined ? "—" : String(n);
}

export function ClassBroadsheet({ classes, sessions }: { classes: Named[]; sessions: Session[] }) {
  const allTerms = sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name })));
  const defaultTerm = allTerms.find((t) => t.isCurrent) ?? allTerms[0];
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [termId, setTermId] = React.useState(defaultTerm?.id ?? "");
  const [sheet, setSheet] = React.useState<Sheet | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!classId || !termId) { setSheet(null); return; }
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/term-results/broadsheet?classId=${classId}&termId=${termId}`);
    setBusy(false);
    if (!res.ok) {
      setSheet(null);
      setMsg(res.status === 404 ? "You can't view this class's score sheet, or it doesn't exist." : `Failed to load (${res.status}).`);
      return;
    }
    setSheet((await res.json()) as Sheet);
  }, [classId, termId]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Class score sheet</CardTitle>
        <CardDescription>
          The whole class for a term: every student against every subject, with each student&apos;s average and
          position. Drafts and unpublished grades are visible to class staff here (this is the working sheet, not the
          family view).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} className={sel}>
            {classes.length === 0 && <option value="">No classes</option>}
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} className={sel}>
            {allTerms.length === 0 && <option value="">No terms defined</option>}
            {allTerms.map((t) => <option key={t.id} value={t.id}>{t.sessionName} — {t.name}</option>)}
          </select>
        </div>

        {sheet && (
          <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="sticky left-0 bg-card px-3 py-2.5 font-medium">Student</th>
                  {sheet.subjects.map((s) => (
                    <th key={s.id} className="px-2 py-2.5 font-medium">{s.name}</th>
                  ))}
                  <th className="px-3 py-2.5 font-medium">Average</th>
                  <th className="px-3 py-2.5 font-medium">Position</th>
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((r) => (
                  <tr key={r.studentId} className="border-b border-border last:border-0">
                    <td className="sticky left-0 whitespace-nowrap bg-card px-3 py-2">
                      <div className="font-medium">{r.studentName}</div>
                      {r.admissionNumber && <div className="text-xs text-muted-foreground">{r.admissionNumber}</div>}
                    </td>
                    {r.cells.map((c) => (
                      <td key={c.subjectId} className="px-2 py-2">
                        {c.total === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span title={c.status || undefined}>
                            {c.total} <span className="text-xs text-muted-foreground">({c.grade})</span>
                            {c.status && c.status !== "PUBLISHED" && (
                              <span className="ml-0.5 text-[10px] uppercase text-amber-600 dark:text-amber-500">
                                {c.status === "PENDING_APPROVAL" ? "·pending" : "·draft"}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2 font-semibold">{fmt(r.average)}</td>
                    <td className="px-3 py-2">{r.position ?? "—"}</td>
                  </tr>
                ))}
                {sheet.rows.length === 0 && (
                  <tr><td colSpan={sheet.subjects.length + 3} className="px-3 py-4 text-muted-foreground">No students enrolled in this class.</td></tr>
                )}
                {sheet.subjects.length === 0 && sheet.rows.length > 0 && (
                  <tr><td colSpan={3} className="px-3 py-4 text-muted-foreground">No subjects are assigned to this class yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {busy && <p className="text-sm text-muted-foreground">Loading…</p>}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
