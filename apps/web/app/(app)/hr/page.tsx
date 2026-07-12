import type { EmployeeDto, LeaveRequestDto, LeaveTypeDto, OrgNodeDto, SalaryChangeDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { money, shortDate, titleCase } from "@/lib/format";
import { EmployeeForm } from "@/components/hr/EmployeeForm";
import { OrgChart } from "@/components/hr/OrgChart";
import { EmployeeRow } from "@/components/hr/EmployeeRow";
import { SalaryChanges } from "@/components/hr/SalaryChanges";
import { LeaveAdmin } from "@/components/hr/LeaveAdmin";

export const dynamic = "force-dynamic";

type Employee = Serialized<EmployeeDto>;

export default async function HrPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "hr.write");
  const canSalaryRequest = hasPermission(user.permissions, "hr.salary.request");
  const canSalaryApprove = hasPermission(user.permissions, "hr.salary.approve");
  const canLeaveManage = hasPermission(user.permissions, "hr.leave.manage");
  const [employees, users, changes, leaveTypes, leaveRequests, coverage, org] = await Promise.all([
    apiGet<Employee[]>("/hr/employees"),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users") : Promise.resolve(null),
    apiGet<Serialized<SalaryChangeDto>[]>("/hr/salary/changes"),
    canLeaveManage ? apiGet<Serialized<LeaveTypeDto>[]>("/hr/leave/types") : Promise.resolve(null),
    canLeaveManage ? apiGet<Serialized<LeaveRequestDto>[]>("/hr/leave/requests") : Promise.resolve(null),
    canLeaveManage ? apiGet<Serialized<LeaveRequestDto>[]>("/hr/leave/calendar") : Promise.resolve(null),
    apiGet<Serialized<OrgNodeDto>[]>("/hr/org"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">HR — staff records</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Employment records. Salaries are encrypted at rest and shown only to HR readers.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link href="/hr/analytics" className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent">Analytics</Link>
            {hasPermission(user.permissions, "hr.recruit.manage") && (
              <Link href="/hr/recruitment" className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent">Recruitment</Link>
            )}
            <Link href="/hr/payroll" className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent">Payroll →</Link>
            <Link href="/hr/attendance" className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent">Attendance →</Link>
          </div>
        </div>

        {/* Staff ACCOUNTS with no employment record yet — the bridge between
            "create profile" (account + role) and HR (employment record). Without
            this, freshly created staff are invisible here until someone knows to
            use the form below. Staff = holds any non-student/non-parent role. */}
        {canWrite && users && (() => {
          const recorded = new Set((employees ?? []).map((e) => e.userId));
          const awaiting = users.filter(
            (u) => !recorded.has(u.id) && u.roles.some((r) => r !== "student" && r !== "parent"),
          );
          if (awaiting.length === 0) return null;
          return (
            <Alert variant="info">
              <AlertTitle>
                {awaiting.length} staff account{awaiting.length === 1 ? "" : "s"} awaiting an employment record
              </AlertTitle>
              <AlertDescription>
                {awaiting.map((u) => u.name).join(", ")} — created as accounts but not yet on the HR
                register. Complete each one with the form below (pick the person, then job title, start
                date and salary).
              </AlertDescription>
            </Alert>
          );
        })()}

        {canWrite && users && (
          <EmployeeForm users={users.filter((u) => u.roles.some((r) => r !== "student" && r !== "parent"))} managers={org ?? []} />
        )}

        {employees === null || employees.length === 0 ? (
          <Alert variant="info"><AlertTitle>No records</AlertTitle><AlertDescription>No employee records yet.</AlertDescription></Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Job title</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Start</th>
                    <th className="px-4 py-2.5 font-medium">Salary</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    {canWrite && <th className="px-4 py-2.5 font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <EmployeeRow key={e.id} e={e} canWrite={canWrite} />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <OrgChart nodes={org ?? []} />
        <SalaryChanges
          employees={employees ?? []}
          changes={changes ?? []}
          canRequest={canSalaryRequest}
          canApprove={canSalaryApprove}
          userId={user.id}
        />

        {canLeaveManage && <LeaveAdmin types={leaveTypes ?? []} requests={leaveRequests ?? []} coverage={coverage ?? []} />}
      </div>
    </AppShell>
  );
}
