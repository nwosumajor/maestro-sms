import type { AssessmentSubmissionDto, AssessmentSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortDate } from "@/lib/format";
import { SubmissionFileLink } from "@/components/assessment/SubmissionFileLink";

export const dynamic = "force-dynamic";

export default async function AssessmentSubmissionsPage({ params }: { params: { assessmentId: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "integrity.report.read")) redirect("/dashboard");
  const { assessmentId } = params;
  const [submissions, list] = await Promise.all([
    apiGet<Serialized<AssessmentSubmissionDto>[]>(`/assessments/${assessmentId}/submissions`),
    apiGet<Serialized<AssessmentSummaryDto>[]>("/assessments"),
  ]);
  const title = list?.find((a) => a.id === assessmentId)?.title ?? "Assessment";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="assessments" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/assessments" className="text-sm text-muted-foreground hover:underline">← Back to assessments</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Submissions. Open one to review its integrity signals.</p>
        </div>

        {submissions === null ? (
          <Alert variant="info"><AlertTitle>Not available</AlertTitle><AlertDescription>This assessment isn&apos;t accessible to you.</AlertDescription></Alert>
        ) : submissions.length === 0 ? (
          <Alert variant="info"><AlertTitle>No submissions</AlertTitle><AlertDescription>No one has submitted yet.</AlertDescription></Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Student</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Submitted</th>
                    <th className="px-4 py-2.5 font-medium">Signals</th>
                    <th className="px-4 py-2.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{s.studentName ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.status.replace(/_/g, " ").toLowerCase()}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.submittedAt ? shortDate(s.submittedAt) : "—"}</td>
                      <td className="px-4 py-2.5">
                        {s.signalCount > 0 ? <Badge variant="destructive">{s.signalCount}</Badge> : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {s.hasFile && (
                            <SubmissionFileLink assessmentId={assessmentId} submissionId={s.id} fileName={s.fileName} />
                          )}
                          <Link href={`/assessments/${assessmentId}/submissions/${s.id}/integrity`} className="text-primary hover:underline">
                            Integrity report →
                          </Link>
                        </div>
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
