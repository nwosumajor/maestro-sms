import type { AttendanceRecordDto, IdNameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortDate, titleCase } from "@/lib/format";
import { TakeRegister } from "@/components/attendance/TakeRegister";
import { RegisterBoard } from "@/components/attendance/RegisterBoard";
import { ClassAttendanceBoard } from "@/components/attendance/ClassAttendanceBoard";
import { StudentPicker } from "@/components/attendance/StudentPicker";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Student = Serialized<IdNameDto>;
type ClassRow = Serialized<IdNameDto>;
type Record_ = Serialized<AttendanceRecordDto>;
/** A page of history plus the TRUE total — the total is what makes five years of
 *  records navigable instead of silently ending after the first. */
type History = { records: Record_[]; page: number; pageSize: number; total: number };
const PAGE_SIZE = 100;
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
  searchParams: { studentId?: string; page?: string; classId?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // Gate matches this section's AppShell nav entry ("attendance.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "attendance.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "attendance.write");

  const page = Math.max(Number(searchParams.page ?? 1) || 1, 1);

  // ONE round of fetches, not two. The history and summary used to wait for the
  // student list purely to learn which student to ask about — but on every
  // navigation after the first, the URL already says. Waiting anyway cost a full
  // extra round trip on the heaviest page in the app, which on a real connection
  // is felt rather than measured. Only a first visit with no studentId still
  // needs the list first, and that case falls through to the second fetch below.
  const known = searchParams.studentId;
  const historyFor = (id: string) =>
    Promise.all([
      apiGet<History>(`/students/${id}/attendance?page=${page}&pageSize=${PAGE_SIZE}`),
      apiGet<Summary>(`/students/${id}/attendance/summary`),
    ]);

  const [students, count, classes, termLock, preloaded] = await Promise.all([
    // A PAGE of the register (bounded), plus the true total so the picker can say
    // what it is not showing and search the server for the rest.
    apiGet<Student[]>("/students"),
    apiGet<{ students: number }>("/students/count"),
    canWrite ? apiGet<ClassRow[]>("/classes/mine") : Promise.resolve(null),
    canWrite ? apiGet<{ lockBeforeDate: string | null }>("/attendance/term-lock") : Promise.resolve(null),
    known ? historyFor(known) : Promise.resolve(null),
  ]);

  const list = students ?? [];
  const selectedId = known ?? list[0]?.id;
  const [history, summary] = preloaded ?? (selectedId ? await historyFor(selectedId) : [null, null]);
  const records = history?.records ?? (history === null && selectedId ? null : []);
  const total = history?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="attendance" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Attendance</>} subtitle={<>{canWrite
              ? "Take a class register, and review a student's attendance history."
              : "Your attendance history. Guardians are alerted automatically on an absence."}</>} />

        {/* Missing registers first: it is the only thing on this page that is
            time-critical, and the 7-day correction window is why. */}
        {canWrite && <RegisterBoard />}

        {/* Class-by-class attendance for senior staff. Each row carries the server's
            own canTake decision, so a supervisor sees a Take-register button only for
            their class and an administrator sees one everywhere. */}
        {canWrite && <ClassAttendanceBoard />}

        {canWrite && classes && classes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Register</CardTitle>
              <CardDescription>Pick a class and date. Today defaults everyone Present — mark the exceptions and save. Pick a past date (or a register below) to view or correct any day&apos;s register.</CardDescription>
            </CardHeader>
            <CardContent>
              <TakeRegister classes={classes} lockBeforeDate={termLock?.lockBeforeDate ?? null} initialClassId={searchParams.classId} />
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          <StudentPicker students={list} selectedId={selectedId} total={count?.students} />

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
                {/* The history used to stop at 200 rows — about one school year —
                    with nothing to say the rest existed. The total is stated, and
                    every page of it is reachable. */}
                {total > PAGE_SIZE && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
                    <span className="text-muted-foreground tabular-nums">
                      Days {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
                    </span>
                    <div className="flex gap-2">
                      <Link
                        href={`/attendance?studentId=${selectedId}&page=${page - 1}`}
                        aria-disabled={page <= 1}
                        className={buttonVariants({
                          size: "sm",
                          variant: "outline",
                          className: page <= 1 ? "pointer-events-none opacity-50" : "",
                        })}
                      >
                        Newer
                      </Link>
                      <Link
                        href={`/attendance?studentId=${selectedId}&page=${page + 1}`}
                        aria-disabled={page >= pages}
                        className={buttonVariants({
                          size: "sm",
                          variant: "outline",
                          className: page >= pages ? "pointer-events-none opacity-50" : "",
                        })}
                      >
                        Older
                      </Link>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
