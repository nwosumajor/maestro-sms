import type { AttendanceRecordDto, IdNameDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortDate, titleCase } from "@/lib/format";
import { TakeRegister } from "@/components/attendance/TakeRegister";
import { RegisterBoard } from "@/components/attendance/RegisterBoard";
import { StudentPicker } from "@/components/attendance/StudentPicker";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Student = Serialized<IdNameDto>;
type ClassRow = Serialized<IdNameDto>;
type Record_ = Serialized<AttendanceRecordDto>;
type Summary = {
  from: string | null;
  to: string | null;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  percent: number | null;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PRESENT: "secondary",
  ABSENT: "destructive",
  LATE: "default",
  EXCUSED: "outline",
};

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: { studentId?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const canWrite = hasPermission(user.permissions, "attendance.write");

  const [students, classes, termLock] = await Promise.all([
    apiGet<Student[]>("/students"),
    canWrite ? apiGet<ClassRow[]>("/classes/mine") : Promise.resolve(null),
    canWrite ? apiGet<{ lockBeforeDate: string | null }>("/attendance/term-lock") : Promise.resolve(null),
  ]);

  const list = students ?? [];
  const selectedId = searchParams.studentId ?? list[0]?.id;
  const [records, summary] = selectedId
    ? await Promise.all([
        apiGet<Record_[]>(`/students/${selectedId}/attendance`),
        apiGet<Summary>(`/students/${selectedId}/attendance/summary`),
      ])
    : [[], null];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="attendance" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Attendance</>} subtitle={<>{canWrite
              ? "Take a class register, and review a student's attendance history."
              : "Your attendance history. Guardians are alerted automatically on an absence."}</>} />

        {/* Missing registers first: it is the only thing on this page that is
            time-critical, and the 7-day correction window is why. */}
        {canWrite && <RegisterBoard />}

        {canWrite && classes && classes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Register</CardTitle>
              <CardDescription>Pick a class and date. Today defaults everyone Present — mark the exceptions and save. Pick a past date (or a register below) to view or correct any day&apos;s register.</CardDescription>
            </CardHeader>
            <CardContent>
              <TakeRegister classes={classes} lockBeforeDate={termLock?.lockBeforeDate ?? null} />
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          <StudentPicker students={list} selectedId={selectedId} />

          {/* Totals before the log. Nobody reads 200 rows to work out whether a
              child is attending, and this figure is term-scoped the same way the
              report card is, so the two cannot disagree. */}
          {summary && summary.total > 0 && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
                <span>
                  <span className="text-2xl font-semibold tabular-nums">{summary.percent}%</span>{" "}
                  <span className="text-muted-foreground">attended</span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {summary.present} present · {summary.absent} absent · {summary.late} late
                  {summary.excused > 0 ? ` · ${summary.excused} excused` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {summary.from && summary.to ? `this term (${shortDate(summary.from)} – ${shortDate(summary.to)})` : "all recorded days"}
                  {" · "}
                  {summary.total} day{summary.total === 1 ? "" : "s"} recorded
                </span>
              </CardContent>
            </Card>
          )}

          {records === null ? (
            <Alert variant="info">
              <AlertTitle>No access</AlertTitle>
              <AlertDescription>You cannot view this student's attendance.</AlertDescription>
            </Alert>
          ) : records.length === 0 ? (
            <Alert variant="info">
              <AlertTitle>No records</AlertTitle>
              <AlertDescription>No attendance has been recorded yet.</AlertDescription>
            </Alert>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 text-muted-foreground">{shortDate(r.session.date)}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{titleCase(r.status)}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{r.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
