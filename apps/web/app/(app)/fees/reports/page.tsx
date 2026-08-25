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

  // ONE BLOCK PER CURRENCY, the school's own first. An invoice carries its own
  // currency, so the ungrouped totals this replaces added kobo to cents and
  // every figure on the page was drawn under the platform's currency whatever
  // the school billed in. Nearly every school has exactly one block and the page
  // looks unchanged.
  const blocks = r.byCurrency ?? [];
  const ageRowsOf = (b: (typeof blocks)[number]): [string, Bucket][] => [
    ["Current (not overdue)", b.aging.current],
    ["1–30 days overdue", b.aging.d1_30],
    ["31–60 days overdue", b.aging.d31_60],
    ["60+ days overdue", b.aging.d60plus],
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

        {blocks.map((b) => (
          <div key={b.currency} className="space-y-4">
            {blocks.length > 1 && (
              <h2 className="text-sm font-semibold text-muted-foreground">
                {b.currency}
                {b.currency === r.currency ? " (the school's own currency)" : ""}
              </h2>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <Card><CardHeader><CardDescription>Invoiced</CardDescription><CardTitle className="text-2xl">{money(b.totals.invoicedMinor, b.currency)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Collected</CardDescription><CardTitle className="text-2xl">{money(b.totals.collectedMinor, b.currency)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Outstanding</CardDescription><CardTitle className="text-2xl">{money(b.totals.outstandingMinor, b.currency)}</CardTitle></CardHeader></Card>
            </div>

            <Card>
              <CardHeader><CardTitle className="text-base">Receivables aging{blocks.length > 1 ? ` · ${b.currency}` : ""}</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <tbody>
                    {ageRowsOf(b).map(([label, bucket]) => (
                      <tr key={label} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5">{label}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{bucket.count} invoice{bucket.count === 1 ? "" : "s"}</td>
                        <td className="px-4 py-2.5 text-right font-medium">{money(bucket.amountMinor, b.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        ))}

        {(r.pendingApprovals?.byCurrency ?? []).filter((x) => x.count > 0).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Awaiting approval (maker-checker)</CardTitle>
              <CardDescription>
                {/* The threshold is judged in the school's OWN money, so a
                    figure here labelled with the wrong currency misstates the
                    control rather than merely misprinting it. */}
                {r.pendingApprovals!.byCurrency
                  .filter((x) => x.count > 0)
                  .map((x) => `${x.count} payment${x.count === 1 ? "" : "s"}, ${money(x.amountMinor, x.currency)}`)
                  .join(" · ")}
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
