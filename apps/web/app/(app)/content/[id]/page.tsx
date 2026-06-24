import type { ForumPostDto, LmsContentDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { ContentDetail } from "@/components/lms/ContentDetail";

export const dynamic = "force-dynamic";

// One content item. The API decides what this caller may see: students/parents
// only reach PUBLISHED items and never receive quiz answer keys (stripped
// server-side). Forum posts are loaded for thread content. All affordances are
// re-checked by the API on submit.
export default async function ContentDetailPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;

  const content = await apiGet<Serialized<LmsContentDto>>(`/content/${params.id}`);
  const forum =
    content?.type === "FORUM_THREAD"
      ? await apiGet<Serialized<ForumPostDto>[]>(`/content/${params.id}/forum`)
      : null;

  const canQuiz = hasPermission(user.permissions, "lms.quiz.attempt");
  const canPost = hasPermission(user.permissions, "lms.forum.post");
  const isStaff = hasPermission(user.permissions, "lms.content.write");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="classes"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        {content === null ? (
          <Alert variant="info">
            <AlertTitle>Not available</AlertTitle>
            <AlertDescription>
              This content doesn’t exist, isn’t published yet, or you don’t have
              access.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Link
              href={`/classes/${content.classId}/content`}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              ← Back to class content
            </Link>
            <ContentDetail
              content={content}
              forum={forum ?? []}
              canQuiz={canQuiz}
              canPost={canPost}
              isStaff={isStaff}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
