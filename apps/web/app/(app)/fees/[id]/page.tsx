import type { InvoiceDetailDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { money, shortDate, dateTime, titleCase } from "@/lib/format";
import { RecordPaymentForm } from "@/components/fees/RecordPaymentForm";
import { InvoiceActions } from "@/components/fees/InvoiceActions";
import { PayOnlineButton } from "@/components/fees/PayOnlineButton";
import { VerifyPaymentBanner } from "@/components/fees/VerifyPaymentBanner";

export const dynamic = "force-dynamic";

type InvoiceDetail = Serialized<InvoiceDetailDto>;

export default async function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const inv = await apiGet<InvoiceDetail>(`/invoices/${params.id}`);
  if (!inv) notFound();
  const canManage = hasPermission(user.permissions, "fee.manage");
  // Payments when there's a balance; refunds even on a PAID invoice. Not DRAFT/CANCELLED.
  const payable = canManage && inv.status !== "CANCELLED" && inv.status !== "DRAFT";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="fees" permissions={user.permissions}>
      <div className="space-y-6">
        <Link href="/fees" className="text-sm text-muted-foreground hover:underline">
          ← All invoices
        </Link>

        <VerifyPaymentBanner invoiceId={inv.id} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">{inv.reference}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Due {shortDate(inv.dueDate)}</p>
          </div>
          <div className="flex items-center gap-2">
            {inv.overdue && <Badge variant="destructive">Overdue</Badge>}
            <Badge>{titleCase(inv.status)}</Badge>
            {canManage && <InvoiceActions invoiceId={inv.id} status={inv.status} />}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader><CardDescription>Total</CardDescription><CardTitle className="text-2xl">{money(inv.totalMinor, inv.currency)}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Paid</CardDescription><CardTitle className="text-2xl">{money(inv.amountPaidMinor, inv.currency)}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Balance</CardDescription><CardTitle className="text-2xl">{money(inv.balanceMinor, inv.currency)}</CardTitle></CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Line items</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {inv.lineItems.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{l.description}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">×{l.quantity}</td>
                    <td className="px-4 py-2.5 text-right">{money(l.amountMinor * l.quantity, inv.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Payments</CardTitle></CardHeader>
          <CardContent className="p-0">
            {inv.payments.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No payments recorded yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {inv.payments.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">{money(p.amountMinor, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{titleCase(p.method)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{dateTime(p.paidAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {inv.balanceMinor > 0 && inv.status !== "CANCELLED" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pay online</CardTitle>
              <CardDescription>Pay the outstanding {money(inv.balanceMinor, inv.currency)} by card.</CardDescription>
            </CardHeader>
            <CardContent>
              <PayOnlineButton invoiceId={inv.id} />
            </CardContent>
          </Card>
        )}

        {payable && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Record a payment</CardTitle>
              <CardDescription>Outstanding balance: {money(inv.balanceMinor, inv.currency)}</CardDescription>
            </CardHeader>
            <CardContent>
              <RecordPaymentForm invoiceId={inv.id} balanceMinor={inv.balanceMinor} currency={inv.currency} />
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
