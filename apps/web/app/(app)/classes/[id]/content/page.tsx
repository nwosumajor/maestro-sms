import type { LmsContentDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ContentManager } from "@/components/lms/ContentManager";

export const dynamic = "force-dynamic";

// Learning content for one class. Reads are relationship-scoped server-side:
// teachers/school_admin see every item (incl. drafts), students/parents see only
// PUBLISHED content (quiz answer keys stripped by the API). Authoring + the
// submit/review approval flow live in the ContentManager client island; the API
// re-checks every permission, relationship and approval transition.
export default async function ClassContentPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const classId = params.id;

  const content = await apiGet<Serialized<LmsContentDto>[]>(`/classes/${classId}/content`);

  const canAuthor = hasPermission(user.permissions, "lms.content.write");
  const canReview = hasPermission(user.permissions, "lms.content.approve");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="classes"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Learning content</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Materials, lessons, quizzes and forum threads for this class.
            Publication is approval-gated through the principal — only published
            content reaches enrolled students.
          </p>
        </div>

        {content === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              You can’t view content for this class, or the session expired.
            </AlertDescription>
          </Alert>
        ) : (
          <ContentManager
            classId={classId}
            initial={content}
            canAuthor={canAuthor}
            canReview={canReview}
          />
        )}
      </div>
    </AppShell>
  );
}
