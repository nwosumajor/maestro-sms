import type { StudentImportBatchDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { SisImport } from "@/components/admin/SisImport";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "student.import")) redirect("/dashboard");
  const batches = (await apiGet<Serialized<StudentImportBatchDto>[]>("/admin/students/import")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bulk student onboarding (SIS)</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a comprehensive student roster to create SIS profiles. Every batch is reviewed by a
              second admin (maker-checker) before any accounts are created. New accounts get a temporary
              password to reset on first login.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        <SisImport batches={batches} currentUserId={user.id} />
      </div>
    </AppShell>
  );
}
