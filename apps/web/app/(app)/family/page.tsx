import type { FamilyOverviewDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type Overview = Serialized<FamilyOverviewDto>;

const naira = (minor: number) =>
  `₦${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export default async function FamilyPage() {
  const session = await auth();
  const user = session!.user;
  const overview = (await apiGet<Overview>("/family/overview")) ?? { children: [] };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="family" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My children</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything about your linked children in one place — published grades, attendance,
            discipline, tasks and fees. Full detail lives on the{" "}
            <Link className="text-primary hover:underline" href="/gradebook">Grades</Link>,{" "}
            <Link className="text-primary hover:underline" href="/attendance">Attendance</Link> and{" "}
            <Link className="text-primary hover:underline" href="/fees">Fees</Link> pages.
          </p>
        </div>

        {overview.children.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No linked children</AlertTitle>
            <AlertDescription>
              Your account isn&apos;t linked to any students yet — ask the school office to link you.
            </AlertDescription>
          </Alert>
        ) : (
          overview.children.map((c) => (
            <Card key={c.studentId}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <CardTitle className="text-base">
                  {c.studentName}
                  {c.className && <span className="text-muted-foreground"> · {c.className}</span>}
                </CardTitle>
                {c.grades?.sessionAverage != null && (
                  <Badge>Session avg {c.grades.sessionAverage}</Badge>
                )}
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</p>
                  {c.attendance.total === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No registers taken yet.</p>
                  ) : (
                    <>
                      <p className="mt-1 text-2xl font-semibold">{c.attendance.pct}%</p>
                      <p className="text-xs text-muted-foreground">
                        {c.attendance.present} present · {c.attendance.late} late · {c.attendance.absent} absent
                        {c.attendance.excused > 0 ? ` · ${c.attendance.excused} excused` : ""}
                      </p>
                    </>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Grades{c.grades ? ` — ${c.grades.sessionName}` : ""}
                  </p>
                  {!c.grades || c.grades.termAverages.every((t) => t.average === null) ? (
                    <p className="mt-1 text-sm text-muted-foreground">No published results yet.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.grades.termAverages.map((t) => (
                        <li key={t.termId} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">{t.termName}</span>
                          <span className="font-medium">{t.average ?? "—"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Discipline</p>
                  {c.discipline.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No records.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.discipline.map((d) => (
                        <li key={d.id} className="flex justify-between gap-2">
                          <span className="truncate">{d.subject}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{d.status.replace(/_/g, " ").toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tasks &amp; fees</p>
                  {c.tasks.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No assigned tasks.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.tasks.map((t) => (
                        <li key={t.id} className="flex justify-between gap-2">
                          <span className="truncate">{t.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t.assignmentStatus.replace(/_/g, " ").toLowerCase()}{t.dueAt ? ` · due ${date(t.dueAt)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-sm">
                    {c.fees.outstandingMinor > 0 ? (
                      <>
                        <span className="font-medium text-destructive">{naira(c.fees.outstandingMinor)}</span>
                        <span className="text-muted-foreground"> outstanding on {c.fees.unpaidInvoices} invoice{c.fees.unpaidInvoices === 1 ? "" : "s"}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">No outstanding fees.</span>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </AppShell>
  );
}
