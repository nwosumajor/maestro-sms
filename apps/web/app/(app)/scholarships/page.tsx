import type { ScholarshipApplicationDto, ScholarshipPortalDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScholarshipPortal } from "@/components/scholarship/ScholarshipPortal";
import { SchoolApplications } from "@/components/scholarship/SchoolApplications";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Portal = Serialized<ScholarshipPortalDto>;

export default async function ScholarshipsPage() {
  const session = await auth();
  const user = session!.user;
  const canApply = hasPermission(user.permissions, "scholarship.apply");

  // Applicants (parent/teacher) get the interactive portal; staff-read roles see
  // the same OPEN programs as information.
  // Leadership (board / principal / school_admin) hold scholarship.read. That
  // permission used to gate NOTHING — it put this section in the nav and a
  // "Requests & decisions" tile on the dashboard, and the page then told them
  // they could see their students' applications here while fetching none.
  const canOversee = hasPermission(user.permissions, "scholarship.read");
  const [portal, schoolApplications] = await Promise.all([
    canApply ? apiGet<Portal>("/scholarships/portal") : Promise.resolve(null),
    canOversee
      ? apiGet<Serialized<ScholarshipApplicationDto>[]>("/scholarships/school-applications")
      : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="scholarships" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Scholarships</>} subtitle={<>Platform-sponsored scholarships for students at your school. Students request directly with a detailed
            form — the request is approved by the class supervisor, then a parent/guardian, then the principal,
            before the sponsor reviews, examines qualified candidates, and awards the best three.</>} />

        {canApply && portal ? (
          <ScholarshipPortal portal={portal} roles={user.roles} />
        ) : canApply ? (
          <Alert variant="info">
            <AlertTitle>Couldn&apos;t load scholarships</AlertTitle>
            <AlertDescription>Please refresh — your session may have expired.</AlertDescription>
          </Alert>
        ) : null}

        {canOversee && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Your school&apos;s applications</h2>
              <p className="text-xs text-muted-foreground">
                Every request submitted for a student at {user.schoolName}, and where each one has reached.
              </p>
            </div>
            {schoolApplications ? (
              <SchoolApplications applications={schoolApplications} />
            ) : (
              <Alert variant="info">
                <AlertTitle>Couldn&apos;t load your school&apos;s applications</AlertTitle>
                <AlertDescription>
                  This is a failure to load, not a report that there are none. Please refresh.
                </AlertDescription>
              </Alert>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
