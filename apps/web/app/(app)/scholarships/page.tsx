import type { ScholarshipPortalDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScholarshipPortal } from "@/components/scholarship/ScholarshipPortal";

export const dynamic = "force-dynamic";

type Portal = Serialized<ScholarshipPortalDto>;

export default async function ScholarshipsPage() {
  const session = await auth();
  const user = session!.user;
  const canApply = hasPermission(user.permissions, "scholarship.apply");

  // Applicants (parent/teacher) get the interactive portal; staff-read roles see
  // the same OPEN programs as information.
  const portal = canApply ? await apiGet<Portal>("/scholarships/portal") : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="scholarships" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scholarships</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Platform-sponsored scholarships for students at your school. A parent or teacher applies on a student&apos;s
            behalf; a guardian consents; the platform reviews and awards a fees credit.
          </p>
        </div>

        {canApply && portal ? (
          <ScholarshipPortal portal={portal} />
        ) : canApply ? (
          <Alert variant="info">
            <AlertTitle>Couldn&apos;t load scholarships</AlertTitle>
            <AlertDescription>Please refresh — your session may have expired.</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="info">
            <AlertTitle>Oversight view</AlertTitle>
            <AlertDescription>
              Applications are made by parents and teachers. As school leadership you can see your students&apos;
              applications and outcomes here as the programme runs.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
