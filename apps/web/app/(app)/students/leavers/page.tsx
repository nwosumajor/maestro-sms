// The leavers register — who has left, and when.
//
// A school needs this for two ordinary reasons that nothing in the product
// answered before: proving a child is no longer on roll, and finding the one
// pupil who was exited by mistake. Until now a departed pupil simply vanished
// from every list, with no screen anywhere that showed them.
//
// Deliberately its own page rather than a filter on Students. The students list
// answers "who is here"; mixing leavers into it is how a leaver ends up on a
// register or a print run again.

import { redirect } from "next/navigation";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";
import { LeaversTable, RetentionPolicyCard } from "@/components/lms/LeaversTable";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type Leaver = {
  id: string;
  name: string;
  email: string;
  exitedAt: string | null;
  retentionDueAt: string | null;
  dueForReview: boolean;
  outstandingMinor: number;
  docsReleased: boolean;
};
type Page = {
  rows: Leaver[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  retentionYears: number;
  currency: string;
};

export default async function LeaversPage({
  searchParams,
}: {
  searchParams: { page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // Matches the API gate. Deliberately NOT the raise permission: the principal
  // does not hold that one (it would make them eligible for stage 1 and then
  // bar them from stage 2), and they are the person who re-admits.
  if (!hasPermission(user.permissions, "student.profile.read")) redirect("/dashboard");

  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);
  const data = await apiGet<Page>(`/students/exited?page=${page}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="students" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader
            title="Students who have left"
            subtitle={<>Their sign-in access is closed. Their records are kept.</>}
          />
          <Link href="/students" className="text-sm text-muted-foreground hover:underline">
            ← Students
          </Link>
        </div>

        {/* The policy sits WITH the list it governs. A number like this only
            means something next to "3 due for review". */}
        {data && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Records retention</CardTitle>
            </CardHeader>
            <CardContent>
              <RetentionPolicyCard
                years={data.retentionYears}
                canEdit={hasPermission(user.permissions, "student.exit.approve")}
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Leavers register
              {data && data.rows.some((r) => r.dueForReview)
                ? ` — ${data.rows.filter((r) => r.dueForReview).length} due for review`
                : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* `null` from apiGet means the read FAILED, which is not the same
                fact as "nobody has left" — saying "no leavers" here would be
                asserting something we did not learn. */}
            {data === null ? (
              <p className="text-sm text-destructive">
                We couldn&apos;t load the leavers register. Please refresh.
              </p>
            ) : (
              <LeaversTable
                rows={data.rows}
                canReadmit={hasPermission(user.permissions, "student.exit.approve")}
                currency={data.currency}
              />
            )}
          </CardContent>
        </Card>

        {data && (data.hasMore || page > 1) && (
          <div className="flex justify-between">
            <Link
              href={`/students/leavers?page=${page - 1}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              aria-disabled={page === 1}
              style={page === 1 ? { pointerEvents: "none", opacity: 0.5 } : undefined}
            >
              ← Newer
            </Link>
            <Link
              href={`/students/leavers?page=${page + 1}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              aria-disabled={!data.hasMore}
              style={!data.hasMore ? { pointerEvents: "none", opacity: 0.5 } : undefined}
            >
              Older →
            </Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}
