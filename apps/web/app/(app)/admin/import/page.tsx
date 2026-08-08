import type { StudentImportBatchDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SisImport } from "@/components/admin/SisImport";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "student.import")) redirect("/dashboard");
  // A batch list is a MAKER-CHECKER queue: rendering a failed read as "none"
  // hides imports waiting on a second administrator.
  const batches = await apiGet<Serialized<StudentImportBatchDto>[]>("/admin/students/import");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Bulk student onboarding (SIS)</>} subtitle={<>Upload a comprehensive student roster to create SIS profiles. Every batch is reviewed by a
              second admin (maker-checker) before any accounts are created. New accounts get a temporary
              password to reset on first login.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {batches === null && (
          <Alert variant="destructive">
            <AlertTitle>Existing batches could not be loaded</AlertTitle>
            <AlertDescription>
              You can still upload, but any batch already waiting for a second administrator is not shown below.
            </AlertDescription>
          </Alert>
        )}
        <SisImport batches={batches ?? []} currentUserId={user.id} />
      </div>
    </AppShell>
  );
}
