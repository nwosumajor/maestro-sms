// =============================================================================
// Teacher Integrity Report page (Server Component)
// =============================================================================
// Defense in depth on the web tier:
//  1. Require a session.
//  2. Require integrity.report.read BEFORE fetching (students/parents 404 here).
//  3. The API independently re-enforces permission + tenant + teacher ownership.
// We render the same 404 for "no permission" and "not found" so the URL can't be
// used to probe which submissions exist (no cross-tenant/owner existence leak).
// =============================================================================

import { notFound } from "next/navigation";
import { auth } from "@/lib/auth"; // foundation Auth.js instance
import { INTEGRITY_PERMISSIONS } from "@sms/types/permissions/integrity";
import { fetchIntegrityReport } from "@/lib/integrity/reportApi";
import { IntegrityReport } from "@/components/assessment/IntegrityReport";
import { AppShell } from "@/components/shell/AppShell";

export const dynamic = "force-dynamic"; // sensitive, per-request, never static

export default async function IntegrityReportPage({
  params,
}: {
  params: Promise<{ assessmentId: string; submissionId: string }>;
}) {
  const { assessmentId, submissionId } = await params;

  const session = await auth();
  const permissions: string[] = session?.user?.permissions ?? [];
  // SECURITY: gate before any data fetch. Treat missing permission as 404 (not a
  // 403 redirect) so the route reveals nothing about the resource.
  if (!session || !permissions.includes(INTEGRITY_PERMISSIONS.REPORT_READ)) {
    notFound();
  }

  const result = await fetchIntegrityReport(assessmentId, submissionId);
  if (!result.ok) {
    // 404/403 from the API (tenant/ownership) collapse to a local 404.
    notFound();
  }

  return (
    <AppShell
      schoolName={session.user.schoolName ?? "School"}
      userName={session.user.name ?? "Teacher"}
      active="assessments"
    >
      <a
        href={`/assessments/${assessmentId}`}
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to class
      </a>
      <IntegrityReport report={result.report} />
    </AppShell>
  );
}
