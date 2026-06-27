import type { AppraisalDto, LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto, SelfProfileDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LeaveSelfService } from "@/components/hr/LeaveSelfService";
import { MyProfile } from "@/components/hr/MyProfile";
import { MyAppraisals } from "@/components/hr/MyAppraisals";

export const dynamic = "force-dynamic";

export default async function LeavePage() {
  const session = await auth();
  const user = session!.user;
  // Self-service leave is open to any staff member (hr.self).
  if (!hasPermission(user.permissions, "hr.self")) redirect("/dashboard");

  const [types, balances, requests, profile, appraisals] = await Promise.all([
    apiGet<Serialized<LeaveTypeDto>[]>("/hr/leave/types"),
    apiGet<Serialized<LeaveBalanceDto>[]>("/hr/leave/balances/me"),
    apiGet<Serialized<LeaveRequestDto>[]>("/hr/leave/requests/me"),
    apiGet<Serialized<SelfProfileDto>>("/hr/me"),
    apiGet<Serialized<AppraisalDto>[]>("/hr/appraisals/me"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="leave" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leave</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Apply for leave and track your balance. Requests are approved by your head of
            teaching/administration, then HR, then the principal.
          </p>
        </div>
        <LeaveSelfService types={types ?? []} balances={balances ?? []} requests={requests ?? []} />
        <MyAppraisals appraisals={appraisals ?? []} />
        <MyProfile profile={profile} />
      </div>
    </AppShell>
  );
}
