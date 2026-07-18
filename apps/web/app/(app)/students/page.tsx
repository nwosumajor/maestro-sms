import type { IdNameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Student = Serialized<IdNameDto>;

export default async function StudentsPage() {
  const session = await auth();
  const user = session!.user;
  const students = await apiGet<Student[]>("/students");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="students" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Students</>} subtitle={<>Students you can see — your own record, your children, or those you
            teach. Open one for their profile, contacts, and (if permitted) medical record.</>} />

        {students === null || students.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No students</AlertTitle>
            <AlertDescription>There are no student records available to you.</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {students.map((s) => (
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
