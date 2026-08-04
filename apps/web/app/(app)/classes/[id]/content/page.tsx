import Link from "next/link";
import type { LmsContentDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { ContentManager } from "@/components/lms/ContentManager";
import { ClassProgress } from "@/components/lms/ClassProgress";
import { LmsGradebook } from "@/components/lms/LmsGradebook";
import { LiveSessions } from "@/components/lms/LiveSessions";
import { Awards } from "@/components/lms/Awards";
import { PageHeader } from "@/components/shell/PageHeader";
import { ContentFilterBar } from "@/components/lms/ContentFilterBar";
import { SyllabusPanel } from "@/components/lms/SyllabusPanel";

export const dynamic = "force-dynamic";

// Learning content for one class. Reads are relationship-scoped server-side:
// teachers/school_admin see every item (incl. drafts), students/parents see only
// PUBLISHED content (quiz answer keys stripped by the API). Authoring + the
// submit/review approval flow live in the ContentManager client island; the API
// re-checks every permission, relationship and approval transition.
export default async function ClassContentPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { type?: string; status?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const classId = params.id;

  // Filtering narrows the QUERY, not the browser. A class accumulates a year of
  // content, so asking for just the quizzes should cost less, not the same.
  const qs = new URLSearchParams();
  if (searchParams?.type) qs.set("type", searchParams.type);
  if (searchParams?.status) qs.set("status", searchParams.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  // Fetched alongside the content, not after it: the scheme of work is the
  // first thing on the page, and a second round trip to fill it in would show
  // the plan arriving after the items it is supposed to frame.
  const [content, offerings, sessions] = await Promise.all([
    apiGet<Serialized<LmsContentDto>[]>(`/classes/${classId}/content${suffix}`),
    apiGet<Array<{ subjectId: string; subjectName: string; teacherId: string }>>(`/classes/${classId}/subjects`),
    apiGet<Array<{ isCurrent: boolean; terms: Array<{ id: string; name: string; isCurrent: boolean }> }>>("/academic/sessions"),
  ]);
  const currentTerm = (sessions ?? []).flatMap((x) => x.terms).find((t) => t.isCurrent) ?? null;

  const canAuthor = hasPermission(user.permissions, "lms.content.write");
  const canReview = hasPermission(user.permissions, "lms.content.approve");
  const canGrade = hasPermission(user.permissions, "grade.write");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="classes"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <PageHeader title={<>Learning content</>} subtitle={<>Materials, lessons, quizzes and forum threads for this class.
              Publication is approval-gated through the principal — only published
              content reaches enrolled students.</>} />
          {canAuthor && (
            <Link href={`/classes/${classId}/analytics`} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Analytics
            </Link>
          )}
        </div>

        {/* The plan for the term, above the items. "What is this term meant to
            cover, and where are we" is the question this page could not answer. */}
        {currentTerm && (offerings ?? []).length > 0 && (
          <div className="space-y-3">
            {(offerings ?? []).map((o) => (
              <SyllabusPanel
                key={o.subjectId}
                classId={classId}
                subjectId={o.subjectId}
                subjectName={o.subjectName}
                termId={currentTerm.id}
                // The server re-checks this against class_subject_teacher; the
                // flag only decides whether to render the controls.
                canWrite={canAuthor || o.teacherId === user.id}
              />
            ))}
          </div>
        )}

        {content === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              You can’t view content for this class, or the session expired.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {canAuthor && <ClassProgress classId={classId} />}
            <Awards classId={classId} canManage={canAuthor} />
            <LiveSessions classId={classId} canManage={canAuthor} />
            <ContentFilterBar
              classId={classId}
              type={searchParams?.type}
              status={searchParams?.status}
              showStatus={canAuthor}
            />
            <ContentManager
              classId={classId}
              initial={content}
              canAuthor={canAuthor}
              canReview={canReview}
            />
            {canGrade && <LmsGradebook classId={classId} />}
          </>
        )}
      </div>
    </AppShell>
  );
}
