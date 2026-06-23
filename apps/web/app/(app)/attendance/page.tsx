import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { shortDate, titleCase } from "@/lib/format";
import { TakeRegister } from "@/components/attendance/TakeRegister";

export const dynamic = "force-dynamic";

interface Student { id: string; name: string }
interface ClassRow { id: string; name: string }
interface Record_ {
  id: string;
  status: string;
  note: string | null;
  session: { classId: string; date: string };
}

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
  const canWrite = user.permissions.includes("attendance.write");

  const [students, classes] = await Promise.all([
    apiGet<Student[]>("/students"),
    canWrite ? apiGet<ClassRow[]>("/classes/mine") : Promise.resolve(null),
  ]);

  const list = students ?? [];
  const selectedId = searchParams.studentId ?? list[0]?.id;
  const records = selectedId ? await apiGet<Record_[]>(`/students/${selectedId}/attendance`) : [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="attendance" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Attendance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canWrite
              ? "Take a class register, and review a student's attendance history."
              : "Your attendance history. Guardians are alerted automatically on an absence."}
          </p>
        </div>

        {canWrite && classes && classes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Take a register</CardTitle>
              <CardDescription>Pick a class and date, mark each student, and submit.</CardDescription>
            </CardHeader>
            <CardContent>
              <TakeRegister classes={classes} />
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {list.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {list.map((s) => (
                <Link
                  key={s.id}
                  href={`/attendance?studentId=${s.id}`}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    s.id === selectedId
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s.name}
                </Link>
              ))}
            </div>
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
