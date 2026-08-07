import Link from "next/link";
import type { MyLearningDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/shell/PageHeader";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type Learning = Serialized<MyLearningDto>;

const TYPE_LABEL: Record<string, string> = {
  MATERIAL: "Material",
  LESSON: "Lesson",
  QUIZ: "Quiz",
  FORUM_THREAD: "Discussion",
  VIDEO: "Video",
  ASSIGNMENT: "Assignment",
};

/**
 * A student's learning across every class they are enrolled in.
 *
 * The product had no answer to "what do I still have to do?" — a student went
 * Classes -> pick a class -> content, per class, to find out what was new. That is
 * the question the whole module exists to serve, so it gets its own page rather
 * than being buried a level down.
 */
export default async function LearningPage() {
  const session = await auth();
  const user = session!.user;
  // Gate matches this section's AppShell nav entry ("lms.quiz.attempt"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "lms.quiz.attempt")) redirect("/dashboard");
  const data = await apiGet<Learning>("/my/learning");

  const items = data?.items ?? [];
  const outstanding = items.filter((i) => !i.completed);
  const done = items.filter((i) => i.completed);

  // Grouped by class, because that is how a student thinks about their week —
  // "what does Maths want?", not "what is the 4th newest thing".
  const groups = new Map<string, typeof outstanding>();
  for (const i of outstanding) groups.set(i.className, [...(groups.get(i.className) ?? []), i]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="learning" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>My learning</>}
          subtitle={<>Everything published to your classes, with what you haven&apos;t finished first.</>}
        />

        {data === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your role does not include learning content.</AlertDescription>
          </Alert>
        ) : items.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>Nothing yet</AlertTitle>
            <AlertDescription>
              Nothing has been published to your classes yet. It will appear here as soon as it is.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <p className="text-sm">
              {outstanding.length === 0 ? (
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  You&apos;re up to date — all {items.length} item{items.length === 1 ? "" : "s"} completed.
                </span>
              ) : (
                <span className="font-medium">
                  {outstanding.length} item{outstanding.length === 1 ? "" : "s"} not yet completed
                </span>
              )}
            </p>

            {[...groups.entries()].map(([className, group]) => (
              <Card key={className}>
                <CardContent className="p-0">
                  <p className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {className}
                  </p>
                  <ul>
                    {group.map((i) => (
                      <li key={i.id} className="border-b border-border last:border-0">
                        <Link
                          href={`/classes/${i.classId}/content?item=${i.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 hover:bg-accent/40"
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-muted-foreground">○</span>
                            <span className="font-medium">{i.title}</span>
                            <Badge variant="outline">{TYPE_LABEL[i.type] ?? i.type}</Badge>
                          </span>
                          <span className="text-xs text-muted-foreground">{shortDate(i.createdAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}

            {/* Completed work stays reachable but out of the way — this is a to-do
                list first and an archive second. */}
            {done.length > 0 && (
              <details className="rounded-md border">
                <summary className="cursor-pointer px-4 py-2.5 text-sm text-muted-foreground">
                  {done.length} completed
                </summary>
                <ul className="border-t border-border">
                  {done.map((i) => (
                    <li key={i.id} className="border-b border-border last:border-0">
                      <Link
                        href={`/classes/${i.classId}/content?item=${i.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-accent/40"
                      >
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className="text-emerald-600">✓</span>
                          <span>{i.title}</span>
                          <span className="text-xs">· {i.className}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{shortDate(i.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
