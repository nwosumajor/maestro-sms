import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UserRolesManager } from "@/components/admin/UserRolesManager";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const session = await auth();
  const user = session!.user;
  if (!user.permissions.includes("rbac.manage")) redirect("/dashboard");
  const [users, roles] = await Promise.all([
    apiGet<{ id: string; name: string; email: string; roles: string[] }[]>("/users"),
    apiGet<{ name: string }[]>("/admin/roles"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; access</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Assign roles to users in your school. Role→permission definitions are
              platform-level (see Recertification to review them).
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {users === null || users.length === 0 ? (
          <Alert variant="info"><AlertTitle>No users</AlertTitle><AlertDescription>None to manage.</AlertDescription></Alert>
        ) : (
          <UserRolesManager users={users} allRoles={(roles ?? []).map((r) => r.name)} />
        )}
      </div>
    </AppShell>
  );
}
