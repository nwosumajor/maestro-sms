import type { HostelDto, HostelAllocationDto, HostelSummaryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { HostelManager } from "@/components/hostel/HostelManager";
import { Kpi } from "@/components/charts/charts";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function HostelPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hostel.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "hostel.manage");
  // Only a school admin / principal creates hostels; a warden manages their own.
  const canCreate = user.roles.includes("school_admin") || user.roles.includes("principal");
  const isWarden = user.roles.includes("warden") && !canCreate;

  const [hostels, allocations, students, staff, summary] = await Promise.all([
    apiGet<Serialized<HostelDto>[]>("/hostels"),
    apiGet<Serialized<HostelAllocationDto>[]>("/hostels/allocations"),
    canManage ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
    canCreate ? apiGet<{ id: string; name: string; roles?: string[] }[]>("/users?kind=staff") : Promise.resolve([]),
    apiGet<Serialized<HostelSummaryDto>>("/hostels/summary"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hostel" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Hostel Management</>} subtitle={<>{isWarden
              ? "Your assigned hostel — rooms, bed availability, allocations and fees."
              : "Boarding houses, rooms (with rent & custom fields), bed availability, student allocation, and hostel-fee scheduling — billed alongside academic fees."}</>} />

        {summary && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Kpi label="Hostels" value={summary.hostels.toLocaleString()} />
            <Kpi label="Rooms" value={summary.rooms.toLocaleString()} sub={`${summary.beds.toLocaleString()} beds`} />
            <Kpi label="Occupied" value={summary.occupied.toLocaleString()} sub={`${summary.vacant.toLocaleString()} vacant`} />
            <Kpi label="Occupancy" value={summary.occupancyPct != null ? `${summary.occupancyPct}%` : "—"} />
          </div>
        )}

        <HostelManager
          hostels={hostels ?? []}
          allocations={allocations ?? []}
          students={students ?? []}
          staff={staff ?? []}
          canManage={canManage}
          canCreate={canCreate}
        />
      </div>
    </AppShell>
  );
}
