import type { PayrollRunDto, Serialized, StaffLoanDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { PayrollManager } from "@/components/hr/PayrollManager";
import { LoansAdmin } from "@/components/hr/LoansAdmin";

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
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monthly runs snapshot each active employee&apos;s salary into encrypted payslips. Draft → finalize.
          </p>
        </div>
        <PayrollManager runs={runs ?? []} canRun={canRun} />
        <LoansAdmin initial={loans ?? []} canApprove={canApprove} />
      </div>
    </AppShell>
  );
}
