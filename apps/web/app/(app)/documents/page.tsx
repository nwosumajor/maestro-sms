import type { DocumentRowDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortDate, titleCase } from "@/lib/format";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type DocRow = Serialized<DocumentRowDto>;

export default async function DocumentsPage() {
  const session = await auth();
  const user = session!.user;
  const canWrite = hasPermission(user.permissions, "document.write");
  const [docs, students] = await Promise.all([
    apiGet<DocRow[]>("/documents"),
    canWrite ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="documents" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Documents</>} subtitle={<>Report cards, receipts, and certificates. Files are stored in object
            storage; downloads use short-lived signed links.</>} />

        {canWrite && students && <DocumentUpload students={students} />}

        {docs === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your role does not include <code>document.read</code>.</AlertDescription>
          </Alert>
        ) : docs.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No documents</AlertTitle>
            <AlertDescription>Nothing has been shared with you yet.</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Title</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Added</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{d.title}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{titleCase(d.type)}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={d.status === "UPLOADED" ? "secondary" : "outline"}>
                          {titleCase(d.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{shortDate(d.createdAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <DocumentActions
                          id={d.id}
                          title={d.title}
                          canDownload={d.status === "UPLOADED"}
                          canDelete={canWrite}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
