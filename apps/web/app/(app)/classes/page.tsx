import type { ClassDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ClassAdmin } from "@/components/lms/ClassAdmin";

export const dynamic = "force-dynamic";


export default async function ClassesPage() {
  const session = await auth();
  const user = session!.user;
  const canWrite = hasPermission(user.permissions, "class.write");
  const [classes, students, users] = await Promise.all([
    apiGet<ClassDto[]>("/classes/mine"),
    canWrite ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve(null),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My classes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scoped to you: teachers see classes they teach, students see classes
            they are enrolled in. Enforced server-side by relationship checks on
            top of Row-Level Security.
          </p>
        </div>

        {canWrite && classes && students && users && (
          <ClassAdmin classes={classes} students={students} users={users} />
        )}

        {classes === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              Your role does not include <code>class.read</code>, or the session
              expired.
            </AlertDescription>
          </Alert>
        ) : classes.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes yet</AlertTitle>
            <AlertDescription>
              You are not linked to any classes in this school.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {classes.map((c) => (
              <Card key={c.id}>
                <CardHeader>
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <CardDescription>{c.subject ?? "General"}</CardDescription>
                </CardHeader>
                <CardContent>
                  <code className="text-xs text-muted-foreground">{c.id}</code>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
