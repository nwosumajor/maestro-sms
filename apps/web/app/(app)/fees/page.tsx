import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { money, shortDate, titleCase } from "@/lib/format";
import { FeesAdmin } from "@/components/fees/FeesAdmin";
import { PendingPayments, type PendingPayment } from "@/components/fees/PendingPayments";

export const dynamic = "force-dynamic";

interface InvoiceRow {
  id: string;
  reference: string;
  status: string;
  currency: string;
  totalMinor: number;
  dueDate: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DRAFT: "outline",
  ISSUED: "default",
  PARTIALLY_PAID: "secondary",
  PAID: "secondary",
  CANCELLED: "destructive",
};

export default async function FeesPage() {
  const session = await auth();
  const user = session!.user;
  const invoices = await apiGet<InvoiceRow[]>("/invoices");
  const canManage = user.permissions.includes("fee.manage");
  const canApprove = user.permissions.includes("fee.approve");
  const [students, feeItems] = canManage
    ? await Promise.all([
        apiGet<{ id: string; name: string }[]>("/students"),
        apiGet<{ id: string; name: string; amountMinor: number; currency: string }[]>("/fees/items"),
      ])
    : [null, null];
  const pending = canApprove ? await apiGet<PendingPayment[]>("/fees/payments/pending") : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="fees" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fees &amp; Billing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "All invoices in your school. Open one to record a payment."
              : "Invoices for your family. Open one to see the balance and payment history."}
          </p>
        </div>

        {canApprove && pending && pending.length > 0 && <PendingPayments payments={pending} />}

        {canManage && students && (
          <FeesAdmin students={students} items={feeItems ?? []} />
        )}

        {invoices === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your role does not include <code>fee.read</code>.</AlertDescription>
          </Alert>
        ) : invoices.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No invoices</AlertTitle>
            <AlertDescription>There are no invoices to show.</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Reference</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Due</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">{inv.reference}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={STATUS_VARIANT[inv.status] ?? "outline"}>{titleCase(inv.status)}</Badge>
                      </td>
                      <td className="px-4 py-2.5">{money(inv.totalMinor, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{shortDate(inv.dueDate)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={`/fees/${inv.id}`} className="text-sm font-medium text-primary hover:underline">
                          View →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
