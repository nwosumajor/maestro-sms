import type { PayrollRunDto, Serialized, StaffLoanDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LoadFailure } from "@/components/ui/load-failure";
import { PayrollManager } from "@/components/hr/PayrollManager";
import { LoansAdmin } from "@/components/hr/LoansAdmin";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function PayrollPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const canRun = hasPermission(user.permissions, "hr.payroll.run");
  const [runs, loans] = await Promise.all([
    apiGet<Serialized<PayrollRunDto>[]>("/hr/payroll/runs"),
    apiGet<Serialized<StaffLoanDto>[]>("/hr/loans"),
  ]);
  const canApprove = hasPermission(user.permissions, "hr.salary.approve");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Payroll</>} subtitle={<>Monthly runs snapshot each active employee&apos;s salary into encrypted payslips. Draft → finalize.</>} />
        {runs === null ? (
          <LoadFailure what="Payroll runs">
            A run already in DRAFT would not be listed, and starting a new one could duplicate it.
          </LoadFailure>
        ) : (
          <PayrollManager runs={runs} canRun={canRun} />
        )}
        {loans === null ? (
          <LoadFailure what="Loan requests">
            Staff loans awaiting a second approver are not shown — the queue is unknown, not empty.
          </LoadFailure>
        ) : (
          <LoansAdmin initial={loans} canApprove={canApprove} />
        )}
      </div>
    </AppShell>
  );
}
