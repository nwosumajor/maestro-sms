import type { ParentImportBatchDto, IdNameDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { ParentOnboard } from "@/components/admin/ParentOnboard";

export const dynamic = "force-dynamic";

export default async function ParentsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "parent.import")) redirect("/dashboard");
  const [batches, students] = await Promise.all([
    apiGet<Serialized<ParentImportBatchDto>[]>("/admin/parents/import"),
    apiGet<Serialized<IdNameDto>[]>("/students"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Parent onboarding</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Create guardian accounts one at a time or in bulk, generate their sign-in details, and link
              them to their children. Bulk batches are reviewed by a second admin (maker-checker) before any
              account is created.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        <ParentOnboard batches={batches ?? []} students={students ?? []} currentUserId={user.id} />
      </div>
    </AppShell>
  );
}
