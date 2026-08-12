import type { IdNameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/shell/PageHeader";
import { StudentSearch } from "@/components/people/StudentSearch";

export const dynamic = "force-dynamic";

type Student = Serialized<IdNameDto>;

export default async function StudentsPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // Gate matches this section's AppShell nav entry ("student.profile.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "student.profile.read")) redirect("/dashboard");

  // The search runs in the QUERY. The roster list is bounded now (it used to be
  // uncapped so the admin dashboard could count it), so on a large school this page
  // shows a page of the register and search is how you reach the rest — not a
  // convenience over an already-downloaded list.
  const q = searchParams?.q?.trim();
  const [students, count] = await Promise.all([
    apiGet<Student[]>(`/students${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    apiGet<{ students: number }>("/students/count"),
  ]);

  const shown = students ?? [];
  const total = count?.students ?? 0;
  // Only say "showing N of M" when it is actually true; claiming a partial view when
  // you can see everyone is just noise.
  const partial = !q && total > shown.length;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="students" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Students</>} subtitle={<>Students you can see — your own record, your children, or those you
            teach. Open one for their profile, contacts, and (if permitted) medical record.</>} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <StudentSearch initial={q ?? ""} />
          {/* This list is who is HERE. Leavers live on their own page so they
              can never drift back onto a register or a print run. */}
          {hasPermission(user.permissions, "student.profile.read") && (
            <Link href="/students/leavers" className="text-sm text-muted-foreground hover:underline">
              Students who have left →
            </Link>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            {q
              ? `${shown.length} match${shown.length === 1 ? "" : "es"}`
              : partial
                ? `showing ${shown.length} of ${total} — search to find anyone else`
                : `${total} student${total === 1 ? "" : "s"}`}
          </span>
        </div>

        {shown.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>{q ? "No match" : "No students"}</AlertTitle>
            <AlertDescription>
              {q ? `No student matches “${q}”.` : "There are no student records available to you."}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((s) => (
              <Link key={s.id} href={`/students/${s.id}`}>
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="grid h-9 w-9 place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                      {s.name.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="font-medium">{s.name}</span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
