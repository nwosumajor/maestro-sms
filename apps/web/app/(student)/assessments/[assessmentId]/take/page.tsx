// =============================================================================
// Student assessment-taking page (Server Component) — Screen 1
// =============================================================================
// Requires a session. The API resolves the integrity config (consent/exempt/
// toggles) from the verified JWT; the page only renders it. Sensitive +
// per-request, so never static.
// =============================================================================

import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth"; // foundation Auth.js instance
import { AppShell } from "@/components/shell/AppShell";
import { AssessmentTaker } from "@/components/assessment/AssessmentTaker";
import { fetchAssessmentForTaking } from "@/lib/integrity/assessmentApi";

export const dynamic = "force-dynamic";

export default async function TakeAssessmentPage({
  params,
}: {
  params: Promise<{ assessmentId: string }>;
}) {
  const { assessmentId } = await params;

  const session = await auth();
  if (!session?.user) redirect("/login");

  const result = await fetchAssessmentForTaking(assessmentId);
  if (!result.ok) notFound();

  return (
    <AppShell
      schoolName={session.user.schoolName ?? "School"}
      userName={session.user.name ?? "Student"}
      active="assessments"
    >
      <AssessmentTaker
        assessmentTitle={result.data.assessmentTitle}
        timeRemainingLabel={result.data.timeRemainingLabel}
        initialContent={result.data.initialContent}
        integrity={result.data.integrity}
        backHref="/assessments"
        backLabel="Back to assessments"
      />
    </AppShell>
  );
}
