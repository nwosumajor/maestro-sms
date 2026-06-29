import Link from "next/link";
import { notFound } from "next/navigation";
import type { ClassInfoDto } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// Member-facing (parent/student/teacher): subjects, teachers, supervisor — no roster.
export default async function ClassInfoPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const info = await apiGet<ClassInfoDto>(`/classes/${params.id}/info`);
  if (!info) notFound();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{info.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Supervisor: {info.supervisorName ?? "—"}
            </p>
          </div>
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
