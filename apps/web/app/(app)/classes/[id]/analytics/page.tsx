import Link from "next/link";
import type { LmsAnalyticsDto, Serialized, XapiStatementDto } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LmsAnalytics } from "@/components/lms/LmsAnalytics";
import { XapiActivity } from "@/components/lms/XapiActivity";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// Per-class learning analytics (staff-of-class only — the API 404s otherwise).
// Read-only aggregation over completion, quizzes, assignments and live
// attendance; figures are signals for the teacher, never automated judgements.
export default async function ClassAnalyticsPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const classId = params.id;

  const [data, statements] = await Promise.all([
    apiGet<Serialized<LmsAnalyticsDto>>(`/classes/${classId}/analytics`),
    apiGet<Serialized<XapiStatementDto>[]>(`/xapi/statements?classId=${classId}`),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Learning analytics</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Engagement and performance across this class’s content. Signals for your review — never an
              automated judgement of a student.
            </p>
          </div>
          <Link href={`/classes/${classId}/content`} className={buttonVariants({ size: "sm", variant: "outline" })}>
            Back to content
          </Link>
        </div>

        {data === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Analytics are available to teachers of this class only.</AlertDescription>
          </Alert>
        ) : (
          <>
            <LmsAnalytics data={data} />
            <XapiActivity statements={statements ?? []} />
          </>
        )}
      </div>
    </AppShell>
  );
}
