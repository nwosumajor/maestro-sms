import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { DirectorySearch } from "@/components/directory/DirectorySearch";

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "directory.search")) redirect("/dashboard");
  // super_admin searches across ALL schools; others are scoped to their own.
  const crossSchool = hasPermission(user.permissions, "platform.operate");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="directory" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">People directory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Search students and staff by unique ID, name, email{crossSchool ? ", school" : ""}, location or role.
            {crossSchool ? " You can search across every school." : " Scoped to your school."}
          </p>
        </div>
        <DirectorySearch crossSchool={crossSchool} />
      </div>
    </AppShell>
  );
}
