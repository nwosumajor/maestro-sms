import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{roster.class.name} — roster</h1>
            <p className="mt-1 text-sm text-muted-foreground">{roster.class.subject ?? "General"}</p>
          </div>
          <Link href="/classes" className="text-sm text-muted-foreground hover:underline">← Classes</Link>
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
          <CardContent className="space-y-1.5">
            {roster.students.length === 0 && <p className="text-sm text-muted-foreground">No students enrolled.</p>}
            {roster.students.map((s, i) => (
              <div key={s.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-1.5 text-sm">
                <span className="w-6 text-right text-xs text-muted-foreground">{i + 1}</span>
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">{s.email}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
