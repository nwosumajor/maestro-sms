import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErasureReview, type ErasureRequest } from "@/components/privacy/ErasureReview";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function AdminPrivacyPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "privacy.erasure.review")) redirect("/dashboard");
  const requests = (await apiGet<ErasureRequest[]>("/privacy/erasure")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Erasure requests</>} subtitle={<>Right-to-erasure requests to review against retention obligations.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {requests.length === 0 ? (
          <Alert variant="info"><AlertTitle>No requests</AlertTitle><AlertDescription>No erasure requests are pending.</AlertDescription></Alert>
        ) : (
          <ErasureReview requests={requests} />
        )}
      </div>
    </AppShell>
  );
}
