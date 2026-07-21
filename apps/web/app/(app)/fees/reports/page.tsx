import type { FeeReportBucketDto, FeeReportDto, LateFeeConfigDto, Serialized, SettlementAccountDto } from "@sms/types";
import { SettlementAccountCard } from "@/components/fees/SettlementAccountCard";
import { LateFeeConfigCard } from "@/components/fees/LateFeeConfigCard";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { FeeReminderButton } from "@/components/fees/FeeReminderButton";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Bucket = Serialized<FeeReportBucketDto>;
type Report = Serialized<FeeReportDto>;

export default async function FinanceReportsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "fee.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "fee.manage");
  const [r, settlement, lateFee] = await Promise.all([
    apiGet<Report>("/fees/reports"),
    canManage ? apiGet<SettlementAccountDto>("/fees/settlement") : Promise.resolve(null),
    canManage ? apiGet<LateFeeConfigDto>("/fees/late-fee-config") : Promise.resolve(null),
  ]);
  if (!r || r.scope !== "school") redirect("/fees");

  const ageRows: [string, Bucket][] = [
    ["Current (not overdue)", r.aging!.current],
    ["1–30 days overdue", r.aging!.d1_30],
    ["31–60 days overdue", r.aging!.d31_60],
    ["60+ days overdue", r.aging!.d60plus],
  ];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="fees" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Finance reports</>} subtitle={<>Receivables aging and collection summary.</>} />
          <div className="flex items-center gap-4">
            {canManage && (
              <Link href="/fees/disputes" className="text-sm text-muted-foreground hover:underline">Disputes</Link>
            )}
            <Link href="/fees" className="text-sm text-muted-foreground hover:underline">← Fees</Link>
          </div>
        </div>

        {settlement && <SettlementAccountCard initial={settlement} />}
        {lateFee && <LateFeeConfigCard initial={lateFee} />}

        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Journal export</CardTitle>
              <CardDescription>
                Every posted payment (incl. refunds and credits, signed) as CSV for your accounting software.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3 text-sm">
              {(() => {
                const now = new Date();
                const ym = (d: Date) => d.toISOString().slice(0, 10);
                const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
                const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
                const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
                const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
                const links = [
                  ["This month", ym(monthStart), ym(now)],
                  ["Last month", ym(lastMonthStart), ym(lastMonthEnd)],
                  ["Year to date", ym(yearStart), ym(now)],
                ] as const;
                return links.map(([label, from, to]) => (
                  <a
                    key={label}
                    href={`/api/sms/fees/export/journal.csv?from=${from}&to=${to}`}
                    className="text-primary hover:underline"
                    download
                  >
                    {label} ↓
                  </a>
                ));
              })()}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment reminders</CardTitle>
            <CardDescription>Notify guardians of students with outstanding balances (in-app + email/SMS).</CardDescription>
          </CardHeader>
          <CardContent><FeeReminderButton /></CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card><CardHeader><CardDescription>Invoiced</CardDescription><CardTitle className="text-2xl">{money(r.totals!.invoicedMinor)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>Collected</CardDescription><CardTitle className="text-2xl">{money(r.totals!.collectedMinor)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>Outstanding</CardDescription><CardTitle className="text-2xl">{money(r.totals!.outstandingMinor)}</CardTitle></CardHeader></Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Receivables aging</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {ageRows.map(([label, b]) => (
                  <tr key={label} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{label}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{b.count} invoice{b.count === 1 ? "" : "s"}</td>
                    <td className="px-4 py-2.5 text-right font-medium">{money(b.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {r.pendingApprovals!.count > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Awaiting approval (maker-checker)</CardTitle>
              <CardDescription>{r.pendingApprovals!.count} payment(s), {money(r.pendingApprovals!.amountMinor)}</CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
