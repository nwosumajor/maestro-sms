// Scholarship management (platform owner) — create/fund programmes, schedule
// qualification exams, review the cross-tenant application queue and award the
// best three. Moved off the /operator hub to its own sidebar page. Gated on
// scholarship.admin (super_admin only; NON_ELEVATABLE).

import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { ScholarshipAdmin } from "@/components/operator/ScholarshipAdmin";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function OperatorScholarshipsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "scholarship.admin")) redirect("/dashboard");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operatorscholarships" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Scholarship management</>} subtitle={<>Platform-sponsored scholarships across every school: create and fund programmes with 1st/2nd/3rd
            prizes, set the qualification exam (online CBT, games or physical), review the cross-tenant queue
            and award the best three. Program changes and awards need step-up re-auth.</>} />
        <ScholarshipAdmin />
      </div>
    </AppShell>
  );
}
