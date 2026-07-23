// A student's whole-session report card: three terms side by side, each subject's
// four components + weighted total + grade, with term and session averages. Pure
// presentational — the server has already scoped it (published-only for families).

import type { StudentSessionReportDto, Serialized } from "@sms/types";
import { GRADE_COMPONENTS } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TermScoresheetButton } from "@/components/gradebook/TermScoresheetButton";
import { SessionReportButton } from "@/components/gradebook/SessionReportButton";

type Report = Serialized<StudentSessionReportDto>;

function fmt(n: number | null): string {
  return n === null || n === undefined ? "—" : String(n);
}

export function ReportCard({ report }: { report: Report }) {
  const hasAny = report.terms.some((t) => t.subjects.length > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {report.studentName}
          {report.className ? <span className="text-muted-foreground"> · {report.className}</span> : null}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {report.sessionName}
          {report.sessionAverage !== null && (
            <span className="ml-2 font-medium text-foreground">Session average: {report.sessionAverage}</span>
          )}
        </p>
        {hasAny && (
          <div className="pt-1">
            <SessionReportButton studentId={report.studentId} sessionId={report.sessionId} sessionName={report.sessionName} />
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {!hasAny && <p className="text-sm text-muted-foreground">No published results for this session yet.</p>}

        {/* Session summary — the two final categories: each subject's total in
            every term (the last column is the third-term-only grade) and the
            three-term cumulative average. */}
        {report.summary.length > 0 && (
          <div>
            <h3 className="mb-2 font-semibold">Session summary</h3>
            <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2.5 font-medium">Subject</th>
                    {report.terms.map((t, i) => (
                      <th key={t.termId} className="px-2 py-2.5 font-medium">
                        {t.termName}
                        {i === report.terms.length - 1 && (
                          <span className="text-muted-foreground/60"> (final)</span>
                        )}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 font-medium">Average</th>
                  </tr>
                </thead>
                <tbody>
                  {report.summary.map((s) => (
                    <tr key={s.subjectId} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 font-medium">{s.subjectName}</td>
                      {s.termTotals.map((v, i) => (
                        <td
                          key={i}
                          className={`px-2 py-2 ${i === s.termTotals.length - 1 ? "font-medium text-foreground" : ""}`}
                        >
                          {fmt(v)}
                        </td>
                      ))}
                      <td className="px-3 py-2 font-semibold">{fmt(s.average)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {report.terms.map((term) =>
          term.subjects.length === 0 ? null : (
            <div key={term.termId}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{term.termName}</h3>
                <div className="flex items-center gap-3">
                  {term.average !== null && (
                    <span className="text-sm text-muted-foreground">Term average: <span className="font-medium text-foreground">{term.average}</span></span>
                  )}
                  <TermScoresheetButton
                    studentId={report.studentId}
                    sessionId={report.sessionId}
                    termId={term.termId}
                    termName={term.termName}
                  />
                </div>
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2.5 font-medium">Subject</th>
                      {GRADE_COMPONENTS.map((c) => (
                        <th key={c.key} className="px-2 py-2.5 font-medium">{c.label}<span className="text-muted-foreground/60"> /{c.max}</span></th>
                      ))}
                      <th className="px-3 py-2.5 font-medium">Total</th>
                      <th className="px-3 py-2.5 font-medium">Grade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {term.subjects.map((s) => (
                      <tr key={s.subjectId} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-3 py-2 font-medium">{s.subjectName}</td>
                        <td className="px-2 py-2">{fmt(s.exam)}</td>
                        <td className="px-2 py-2">{fmt(s.midterm)}</td>
                        <td className="px-2 py-2">{fmt(s.assignment)}</td>
                        <td className="px-2 py-2">{fmt(s.classNote)}</td>
                        <td className="px-3 py-2 font-medium">{fmt(s.total)}</td>
                        <td className="px-3 py-2 font-medium">{s.grade ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ),
        )}
      </CardContent>
    </Card>
  );
}
