// Server component: renders per-class learning analytics (read-only). Every
// figure is a SIGNAL for the teacher — the UI never labels a student, only
// surfaces low engagement for a human to follow up (Golden Rule #8).
import type { LmsAnalyticsDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Analytics = Serialized<LmsAnalyticsDto>;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Bar({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = percent >= 66 ? "bg-emerald-500" : percent >= 33 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <span className="text-xs tabular-nums">{percent}%</span>
    </div>
  );
}

export function LmsAnalytics({ data }: { data: Analytics }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Students" value={data.studentCount} />
        <Stat label="Published items" value={data.publishedContent} />
        <Stat label="Avg completion" value={`${data.completion.avgPercent}%`} />
        <Stat label="Finished everything" value={data.completion.fullyComplete} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quiz performance</CardTitle>
            <CardDescription>Average of each attempting student’s best score.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.quizzes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No published quizzes.</p>
            ) : (
              <ul className="space-y-2">
                {data.quizzes.map((q) => (
                  <li key={q.contentId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {q.title}
                      <span className="text-muted-foreground"> · {q.studentsAttempted} attempted</span>
                    </span>
                    <Bar percent={q.avgPercent} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assignments</CardTitle>
            <CardDescription>Submissions and average grade (of graded work).</CardDescription>
          </CardHeader>
          <CardContent>
            {data.assignments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No published assignments.</p>
            ) : (
              <ul className="space-y-2">
                {data.assignments.map((a) => (
                  <li key={a.contentId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {a.title}
                      <span className="text-muted-foreground">
                        {" "}
                        · {a.submitted} submitted, {a.graded} graded
                      </span>
                    </span>
                    <Bar percent={a.avgPercent} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Student engagement</CardTitle>
          <CardDescription>
            Lowest first — a signal of who might need a check-in, not a score. Live: {data.live.totalJoins} joins across{" "}
            {data.live.sessions} session{data.live.sessions === 1 ? "" : "s"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1.5 pr-2">Student</th>
                  <th className="px-2">Completed</th>
                  <th className="px-2">Quizzes</th>
                  <th className="px-2">Assignments</th>
                  <th className="px-2">Live</th>
                  <th className="px-2">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {data.engagement.map((s) => (
                  <tr key={s.studentId} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">
                      {s.studentName}
                      {s.engagementPercent < 33 && (
                        <Badge variant="destructive" className="ml-2">
                          low
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 tabular-nums">{s.completed}</td>
                    <td className="px-2 tabular-nums">{s.quizzesTaken}</td>
                    <td className="px-2 tabular-nums">{s.assignmentsSubmitted}</td>
                    <td className="px-2 tabular-nums">{s.liveJoined}</td>
                    <td className="px-2">
                      <Bar percent={s.engagementPercent} />
                    </td>
                  </tr>
                ))}
                {data.engagement.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-center text-muted-foreground">
                      No enrolled students yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
