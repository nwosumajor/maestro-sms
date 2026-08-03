import Link from "next/link";
import { redirect } from "next/navigation";
import type { Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { buttonVariants } from "@/components/ui/button";
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
};

export default async function ArchivesPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "privacy.archive.manage")) redirect("/admin");

  const archives = (await apiGet<Serialized<Archive>[]>("/privacy/archives")) ?? [];

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

        <ArchivePanel initial={archives} />
      </div>
    </AppShell>
  );
}
