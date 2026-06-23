import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportStudents } from "@/components/admin/ImportStudents";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await auth();
  const user = session!.user;
  if (!user.permissions.includes("class.write")) redirect("/dashboard");
  const classes = (await apiGet<{ id: string; name: string }[]>("/classes/mine")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bulk import students</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Create student accounts in bulk. Existing emails are skipped; new
              accounts get a temporary password to reset.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paste a roster</CardTitle>
            <CardDescription>One student per line.</CardDescription>
          </CardHeader>
          <CardContent>
            <ImportStudents classes={classes} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
