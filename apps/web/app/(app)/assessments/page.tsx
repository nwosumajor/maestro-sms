import type { AssessmentPageDto, AssessmentSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LoadFailure } from "@/components/ui/load-failure";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CreateAssessment } from "@/components/assessment/CreateAssessment";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Assessment = Serialized<AssessmentSummaryDto>;

export default async function AssessmentsPage({
  searchParams,
}: {
  searchParams?: { classId?: string; q?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "assessment.read")) redirect("/dashboard");
  const canReview = hasPermission(user.permissions, "integrity.report.read");
  const canWrite = hasPermission(user.permissions, "assessment.write");
  const qs = new URLSearchParams();
  for (const key of ["classId", "q", "page"] as const) {
    const v = searchParams?.[key];
    if (v) qs.set(key, v);
  }
  const [assessmentsData, classes] = await Promise.all([
    // Every filter narrows the QUERY. The list is paged, so an older assessment
    // is reachable by searching its title or stepping back a page — it used to
    // be the 500 most recent and nothing else, with nothing saying so.
    apiGet<Serialized<AssessmentPageDto>>(`/assessments${qs.toString() ? `?${qs}` : ""}`),
    apiGet<{ id: string; name: string }[]>("/classes/mine"),
  ]);
  const assessments = assessmentsData?.items ?? [];
  const total = assessmentsData?.total ?? 0;
  const page = assessmentsData?.page ?? 1;
  const pageSize = assessmentsData?.pageSize ?? 30;
  const assessmentsUnavailable = assessmentsData === null;
  /** Keep the class filter and the search when paging. */
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (searchParams?.classId) p.set("classId", searchParams.classId);
    if (searchParams?.q) p.set("q", searchParams.q);
    if (n > 1) p.set("page", String(n));
    return p.toString() ? `/assessments?${p}` : "/assessments";
  };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="assessments" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Assessments</>} subtitle={<>{canReview
              ? "Assessments you own or teach. Open one to review submissions and integrity signals."
              : "Your assessments. Open one to work on it."}</>} />

        {(classes ?? []).length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Class</span>
            <Link
              href="/assessments"
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${!searchParams?.classId ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
            >
              All
            </Link>
            {(classes ?? []).map((c) => (
              <Link
                key={c.id}
                href={`/assessments?classId=${c.id}`}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${searchParams?.classId === c.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}

        {/* Search the title, because "find the mid-term essay" is how the
            question arrives when the class filter alone is not enough. */}
        <form method="GET" className="flex flex-wrap items-end gap-2">
          {searchParams?.classId && <input type="hidden" name="classId" value={searchParams.classId} />}
          <input
            name="q"
            defaultValue={searchParams?.q ?? ""}
            placeholder="Search by title"
            className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Search assessments by title"
          />
          <button type="submit" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
            Search
          </button>
          {searchParams?.q && (
            <Link href={searchParams.classId ? `/assessments?classId=${searchParams.classId}` : "/assessments"} className="text-sm underline underline-offset-2">
              Clear
            </Link>
          )}
        </form>

        {canWrite && <CreateAssessment classes={classes ?? []} />}

        {assessmentsUnavailable ? (
          <LoadFailure what="Assessments">
            A pupil with work due would still have it due; this page just cannot see it right now.
          </LoadFailure>
        ) : assessments.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No assessments</AlertTitle>
            <AlertDescription>
              {searchParams?.q || searchParams?.classId
                ? "Nothing matches that search. Clear it to see the rest."
                : "Nothing here yet for your account."}
            </AlertDescription>
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
                        {a.fileUploadEnabled && <Badge variant="outline" className="ml-2">file upload</Badge>}
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

        {/* What is SHOWN out of what MATCHES. Without it, a truncated list reads
            as the complete answer — which is how 41 assessments on this very
            school were unreachable and unremarked. */}
        {total > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
              {searchParams?.q || searchParams?.classId ? " matching" : ""}
            </span>
            {total > pageSize && (
              <span className="flex items-center gap-3">
                {page > 1 && <Link href={pageHref(page - 1)} className="underline underline-offset-2">Previous</Link>}
                <span>Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span>
                {page * pageSize < total && <Link href={pageHref(page + 1)} className="underline underline-offset-2">Next</Link>}
              </span>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
