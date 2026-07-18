import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateUserForm } from "@/components/admin/CreateUserForm";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type SchoolUser = { id: string; uniqueId: string; name: string; email: string; status: string; roles: string[] };

export default async function AdminUsersPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "rbac.manage")) redirect("/dashboard");

  const [users, roles] = await Promise.all([
    apiGet<SchoolUser[]>("/admin/users"),
    apiGet<{ name: string }[]>("/admin/roles"),
  ]);
  // A school-level admin can never mint a cross-tenant operator.
  const assignable = (roles ?? []).map((r) => r.name).filter((r) => r !== "super_admin");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>School profiles</>} subtitle={<>Create and view the people in your school. Use Roles &amp; access to change a user&apos;s roles.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        <CreateUserForm roles={assignable} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Users ({users?.length ?? 0})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(users ?? []).length === 0 && <p className="text-sm text-muted-foreground">No users yet.</p>}
            {(users ?? []).map((u) => (
              <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {u.name} <span className="font-normal text-muted-foreground">· {u.email}</span>
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">{u.uniqueId}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge variant={u.status === "ACTIVE" ? "secondary" : "destructive"}>{u.status.toLowerCase()}</Badge>
                    {u.roles.map((r) => (
                      <Badge key={r} variant="outline" className="font-mono text-[10px]">{r}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
