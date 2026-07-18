import type { AppraisalDto, DutyAssignmentDto, LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto, MyPayslipDto, SelfProfileDto, Serialized, StaffAttendanceDto, StaffLoanDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LeaveSelfService } from "@/components/hr/LeaveSelfService";
import { MyProfile } from "@/components/hr/MyProfile";
import { MyAppraisals } from "@/components/hr/MyAppraisals";
import { MyCompensation } from "@/components/hr/MyCompensation";
import { MyAttendance } from "@/components/hr/MyAttendance";
import { MyDuties } from "@/components/hr/DutyRoster";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function LeavePage() {
  const session = await auth();
  const user = session!.user;
  // Self-service leave is open to any staff member (hr.self).
  if (!hasPermission(user.permissions, "hr.self")) redirect("/dashboard");

  const [types, balances, requests, profile, appraisals, slips, loans, attendance, duties] = await Promise.all([
    apiGet<Serialized<LeaveTypeDto>[]>("/hr/leave/types"),
    apiGet<Serialized<LeaveBalanceDto>[]>("/hr/leave/balances/me"),
    apiGet<Serialized<LeaveRequestDto>[]>("/hr/leave/requests/me"),
    apiGet<Serialized<SelfProfileDto>>("/hr/me"),
    apiGet<Serialized<AppraisalDto>[]>("/hr/appraisals/me"),
    apiGet<Serialized<MyPayslipDto>[]>("/hr/payroll/me/payslips"),
    apiGet<Serialized<StaffLoanDto>[]>("/hr/loans/me"),
    apiGet<Serialized<StaffAttendanceDto>[]>("/hr/attendance/me"),
    apiGet<Serialized<DutyAssignmentDto>[]>("/hr/duty/me"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="leave" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Leave</>} subtitle={<>Apply for leave and track your balance. Requests are approved by your head of
            teaching/administration, then HR, then the principal.</>} />
        <LeaveSelfService types={types ?? []} balances={balances ?? []} requests={requests ?? []} />
        <MyAttendance initial={attendance ?? []} />
        <MyDuties initial={duties ?? []} />
        <MyCompensation slips={slips ?? []} loans={loans ?? []} />
        <MyAppraisals appraisals={appraisals ?? []} />
        <MyProfile profile={profile} />
      </div>
    </AppShell>
  );
}
