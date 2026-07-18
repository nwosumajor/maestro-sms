import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RosterStudents } from "@/components/lms/RosterStudents";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Person = { id: string; name: string; email: string };
type Roster = {
  class: { id: string; name: string; subject: string | null };
  teachers: Person[];
  students: Person[];
};

export default async function ClassRosterPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  // 404-not-403: the API returns 404 (null here) for a class the caller can't see.
  const roster = await apiGet<Roster>(`/classes/${params.id}`);
  if (!roster) notFound();
  const canWrite = hasPermission(user.permissions, "enrollment.write");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>{roster.class.name} — roster</>} subtitle={<>{roster.class.subject ?? "General"}</>} />
          <div className="flex items-center gap-3">
            <a href={`/api/sms/classes/${params.id}/roster.csv`} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Export CSV
            </a>
            <Link href="/classes" className="text-sm text-muted-foreground hover:underline">← Classes</Link>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Teachers ({roster.teachers.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {roster.teachers.length === 0 && <p className="text-sm text-muted-foreground">No teachers assigned.</p>}
            {roster.teachers.map((t) => (
              <Badge key={t.id} variant="secondary">{t.name}</Badge>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Students ({roster.students.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <RosterStudents classId={params.id} students={roster.students} canWrite={canWrite} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
