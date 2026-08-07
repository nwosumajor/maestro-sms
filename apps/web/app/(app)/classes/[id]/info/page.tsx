import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ClassInfoDto } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// Member-facing (parent/student/teacher): subjects, teachers, supervisor — no roster.
export default async function ClassInfoPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  // Same gate as the section index — a detail page is reachable by URL
  // whether or not the list that links to it was.
  if (!hasPermission(user.permissions, "class.read")) redirect("/dashboard");
  const info = await apiGet<ClassInfoDto>(`/classes/${params.id}/info`);
  if (!info) notFound();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>{info.name}</>} subtitle={<>Supervisor: {info.supervisorName ?? "—"}</>} />
          <Link href="/classes" className="text-sm text-muted-foreground hover:underline">← Classes</Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subjects &amp; teachers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {info.subjects.length === 0 && <p className="text-sm text-muted-foreground">No subjects assigned yet.</p>}
            {info.subjects.map((s, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm">
                <span className="font-medium">{s.subjectName}</span>
                <span className="text-muted-foreground">{s.teacherName}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
