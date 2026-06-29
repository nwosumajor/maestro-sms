import type { AssessmentSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

type Assessment = Serialized<AssessmentSummaryDto>;

export default async function AssessmentsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "assessment.read")) redirect("/dashboard");
  const canReview = hasPermission(user.permissions, "integrity.report.read");
  const assessments = (await apiGet<Assessment[]>("/assessments")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="assessments" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assessments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canReview
              ? "Assessments you own or teach. Open one to review submissions and integrity signals."
              : "Your assessments. Open one to work on it."}
          </p>
        </div>

        {assessments.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No assessments</AlertTitle>
            <AlertDescription>Nothing here yet for your account.</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Title</th>
                    <th className="px-4 py-2.5 font-medium">Class</th>
                    <th className="px-4 py-2.5 font-medium">{canReview ? "Submissions" : "Status"}</th>
                    <th className="px-4 py-2.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {assessments.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">
                        {a.title}
                        {a.integrityEnabled && <Badge variant="outline" className="ml-2">integrity on</Badge>}
                        {a.description && <p className="text-xs font-normal text-muted-foreground">{a.description}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{a.className ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        {canReview ? a.submissionCount : (a.mySubmissionStatus ? <Badge variant="secondary">{a.mySubmissionStatus.replace(/_/g, " ").toLowerCase()}</Badge> : "—")}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canReview ? (
                          <Link href={`/assessments/${a.id}`} className="text-primary hover:underline">Submissions →</Link>
                        ) : (
                          <Link href={`/assessments/${a.id}/take`} className="text-primary hover:underline">Open →</Link>
                        )}
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
