import Link from "next/link";
import { redirect } from "next/navigation";
import type { AcademicSessionDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArchivePanel } from "@/components/privacy/ArchivePanel";

export const dynamic = "force-dynamic";

// The long-term retrieval artifact, made reachable by the people it is for.
//
// Gated on privacy.archive.manage rather than compliance.manage: an archive is
// the whole institution for a year in one file, including staff salaries, so it
// is held deliberately rather than inherited by whoever handles breach paperwork.

type Archive = {
  id: string;
  label: string;
  sizeBytes: number;
  checksum: string;
  sections: Record<string, number>;
  containsHrPii: boolean;
  createdAt: string;
  scope: { kind: "session" | "term"; from: string; to: string } | null;
};

export default async function ArchivesPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "privacy.archive.manage")) redirect("/admin");

  // NULL means the read failed; [] means there genuinely are none. Collapsed,
  // a failure told a data-protection officer this school has produced no
  // archive — the exact question this page exists to answer.
  const archives = await apiGet<Serialized<Archive>[]>("/privacy/archives");

  // THE SESSIONS AND TERMS THIS SCHOOL ACTUALLY HAS.
  //
  // The panel used to take a TYPED label, which is how an archive came to be
  // labelled for a year and hold every year. `POST /privacy/archives` accepts
  // `sessionId`/`termId` and that is what BOUNDS the export; a label alone
  // bounds nothing. A typed year also cannot be checked: "2025/2026",
  // "2025-2026" and "2025/26" are three different archives of the same year to
  // anyone searching in ten years, and a typo is unnoticeable.
  //
  // Read here rather than in the client so the picker is populated on first
  // paint — a principal who opens this page is ready to archive, not to wait.
  // NULL means the read failed; the panel says so rather than showing an empty
  // picker, which would read as "this school has no sessions".
  const sessions = await apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Long-term archives</>}
            subtitle={
              <>
                What this school can still produce in ten years. Take one at the end of every academic session and
                it will answer an investigation, an audit or a records request long after the people involved have left.
              </>
            }
          />
          <Link href="/admin" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Admin
          </Link>
        </div>

        {archives === null ? (
          <Alert variant="destructive">
            <AlertTitle>The archive list could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that no archive exists. Reload before concluding anything about what this
              school can still produce.
            </AlertDescription>
          </Alert>
        ) : (
          <ArchivePanel initial={archives} sessions={sessions} />
        )}
      </div>
    </AppShell>
  );
}
