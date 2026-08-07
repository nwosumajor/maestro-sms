import type { DocumentRowDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentBrowser } from "@/components/documents/DocumentBrowser";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type DocRow = Serialized<DocumentRowDto>;

export default async function DocumentsPage() {
  const session = await auth();
  const user = session!.user;
  // Gate matches this section's AppShell nav entry ("document.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "document.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "document.write");
  // The roster is no longer prefetched — the upload form searches for a student.
  const page = await apiGet<{ items: DocRow[]; nextCursor: string | null }>("/documents");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="documents" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Documents</>} subtitle={<>Report cards, receipts, and certificates. Files are stored in object
            storage; downloads use short-lived signed links.</>} />

        {canWrite && <DocumentUpload />}

        {page === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your role does not include <code>document.read</code>.</AlertDescription>
          </Alert>
        ) : (
          <DocumentBrowser
            initial={page.items ?? []}
            initialCursor={page.nextCursor ?? null}
            canWrite={canWrite}
          />
        )}
      </div>
    </AppShell>
  );
}
