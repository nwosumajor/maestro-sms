"use client";

// Subject performance for a term: one row per class-subject, with the COMPONENT
// averages beside the overall one.
//
// Two audiences, one panel. A subject teacher sees the class-subjects they
// teach; leadership (principal / head teacher / school admin / board / junior
// admin) sees the school's. The server decides which — from the same offering
// table that decides who may GRADE a class-subject — and says so in `scope`, so
// this heading can state what is being shown rather than leaving a teacher to
// wonder whether their school really has two subjects.
//
// The component columns are the point. A class averaging 58 with an exam mean of
// 31/60 and an assignment mean of 9/10 has an exam problem, not a coursework
// problem, and that is something a teacher can act on before the next term.

import type { AcademicSessionDto, Serialized, SubjectAnalyticsDto } from "@sms/types";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Session = Serialized<AcademicSessionDto>;
type Analytics = Serialized<SubjectAnalyticsDto>;

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const fmt = (n: number | null): string => (n === null || n === undefined ? "—" : String(n));

export function SubjectAnalytics({ sessions }: { sessions: Session[] }) {
  const allTerms = sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name })));
  const defaultTerm = allTerms.find((t) => t.isCurrent) ?? allTerms[0];
  const [termId, setTermId] = React.useState(defaultTerm?.id ?? "");
  const [data, setData] = React.useState<Analytics | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!termId) { setData(null); return; }
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/term-results/analytics?termId=${termId}`);
    setBusy(false);
    if (!res.ok) {
      setData(null);
      setMsg(`Couldn't load subject performance (${res.status}).`);
      return;
    }
    setData((await res.json()) as Analytics);
  }, [termId]);

  React.useEffect(() => { load(); }, [load]);

  const rows = data?.rows ?? [];
  const bandNames = rows[0]?.bands.map((b) => b.grade) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Subject performance</CardTitle>
        <CardDescription>
          {data?.scope === "school"
            ? "Every class-subject in the school for the term, with the average of each component."
            : "The class-subjects you teach, with the average of each component — where a class gained or lost marks."}{" "}
          Marks still in draft are included, so this works before results are published; the Published column says how
          many are final.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} className={sel}>
            {allTerms.length === 0 && <option value="">No terms defined</option>}
            {allTerms.map((t) => (
              <option key={t.id} value={t.id}>{t.sessionName} · {t.name}</option>
            ))}
          </select>
          {busy && <span className="text-sm text-muted-foreground">Loading…</span>}
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        {!busy && !msg && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No marks recorded for this term yet.
          </p>
        )}

        {rows.length > 0 && (
          // Wide table: scrolls inside its own box rather than pushing the page sideways.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Class</th>
                  <th className="py-1 pr-3 font-medium">Subject</th>
                  <th className="py-1 pr-3 font-medium">Marks</th>
                  <th className="py-1 pr-3 font-medium">Published</th>
                  <th className="py-1 pr-3 font-medium">Average</th>
                  <th className="py-1 pr-3 font-medium">Range</th>
                  <th className="py-1 pr-3 font-medium">Exam</th>
                  <th className="py-1 pr-3 font-medium">Mid</th>
                  <th className="py-1 pr-3 font-medium">Assn</th>
                  <th className="py-1 pr-3 font-medium">Note</th>
                  {bandNames.map((g) => (
                    <th key={g} className="py-1 pr-2 font-medium">{g}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.classId}-${r.subjectId}`} className="border-b border-border/50">
                    <td className="py-1 pr-3">{r.className}</td>
                    <td className="py-1 pr-3">{r.subjectName}</td>
                    <td className="py-1 pr-3">{r.entered}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{r.published}</td>
                    <td className="py-1 pr-3 font-medium">{fmt(r.averageTotal)}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{fmt(r.lowest)}–{fmt(r.highest)}</td>
                    <td className="py-1 pr-3">{fmt(r.components.exam)}</td>
                    <td className="py-1 pr-3">{fmt(r.components.midterm)}</td>
                    <td className="py-1 pr-3">{fmt(r.components.assignment)}</td>
                    <td className="py-1 pr-3">{fmt(r.components.classNote)}</td>
                    {r.bands.map((b) => (
                      <td key={b.grade} className="py-1 pr-2 text-muted-foreground">{b.count}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
