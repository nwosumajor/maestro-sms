import type { HostelDto, HostelAllocationDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { HostelManager } from "@/components/hostel/HostelManager";

export const dynamic = "force-dynamic";

export default async function HostelPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hostel.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "hostel.manage");

  const [hostels, allocations, students] = await Promise.all([
    apiGet<Serialized<HostelDto>[]>("/hostels"),
    apiGet<Serialized<HostelAllocationDto>[]>("/hostels/allocations"),
    canManage ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hostel" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hostel Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Boarding houses, rooms (with rent &amp; custom fields), bed availability, student allocation, and hostel-fee
            scheduling — billed alongside academic fees.
          </p>
        </div>
        <HostelManager
          hostels={hostels ?? []}
          allocations={allocations ?? []}
          students={students ?? []}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
