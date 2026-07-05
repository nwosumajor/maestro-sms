// A student's whole-session report card: three terms side by side, each subject's
// four components + weighted total + grade, with term and session averages. Pure
// presentational — the server has already scoped it (published-only for families).

import type { StudentSessionReportDto, Serialized } from "@sms/types";
import { GRADE_COMPONENTS } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      </CardHeader>
      <CardContent className="space-y-6">
        {!hasAny && <p className="text-sm text-muted-foreground">No published results for this session yet.</p>}
        {report.terms.map((term) =>
          term.subjects.length === 0 ? null : (
            <div key={term.termId}>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="font-semibold">{term.termName}</h3>
                {term.average !== null && (
                  <span className="text-sm text-muted-foreground">Term average: <span className="font-medium text-foreground">{term.average}</span></span>
                )}
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2.5 font-medium">Subject</th>
                      {GRADE_COMPONENTS.map((c) => (
                        <th key={c.key} className="px-2 py-2.5 font-medium">{c.label}<span className="text-muted-foreground/60"> /{c.weight}</span></th>
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
