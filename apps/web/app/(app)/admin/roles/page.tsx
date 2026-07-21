import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UserRolesManager } from "@/components/admin/UserRolesManager";
import { MfaPolicyCard } from "@/components/admin/MfaPolicyCard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "rbac.manage")) redirect("/dashboard");
  const [users, roles] = await Promise.all([
    apiGet<{ id: string; name: string; email: string; roles: string[] }[]>("/users"),
    apiGet<{ name: string }[]>("/admin/roles"),
  ]);
  const mfaPolicy = await apiGet<{ requireStaffMfa: boolean }>("/admin/security/mfa-policy");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Roles &amp; access</>} subtitle={<>Assign roles to users in your school. Role→permission definitions are
              platform-level (see Recertification to review them).</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {mfaPolicy && <MfaPolicyCard initial={mfaPolicy.requireStaffMfa} />}

        {users === null || users.length === 0 ? (
          <Alert variant="info"><AlertTitle>No users</AlertTitle><AlertDescription>None to manage.</AlertDescription></Alert>
        ) : (
          <UserRolesManager users={users} allRoles={(roles ?? []).map((r) => r.name)} />
        )}
      </div>
    </AppShell>
  );
}
