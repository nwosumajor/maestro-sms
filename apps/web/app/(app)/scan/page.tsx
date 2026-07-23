import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { ScanConsole } from "@/components/scan/ScanConsole";

export const dynamic = "force-dynamic";

// ID-card scan desk. A handheld scanner (or phone) reads the QR on a member's
// card, which contains their global uniqueId; the lookup resolves it to a member
// of THIS school only (tenant-scoped, audited). member.scan gated.
export default async function ScanPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "member.scan")) {
    return (
      <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="scan" permissions={user.permissions}>
        <PageHeader title="Scan" subtitle="You do not have access to the scan desk." />
      </AppShell>
    );
  }
  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="scan" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title="ID card scan"
          subtitle="Scan a member's ID card (or type their code) to confirm their identity at the library, gate, exam hall or register."
        />
        <ScanConsole />
      </div>
    </AppShell>
  );
}
