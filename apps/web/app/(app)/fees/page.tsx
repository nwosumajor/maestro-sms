import type { InvoiceListItemDto, InvoiceSummaryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FeesAdmin } from "@/components/fees/FeesAdmin";
import { PendingPayments, type PendingPayment } from "@/components/fees/PendingPayments";
import { InvoiceBrowser } from "@/components/fees/InvoiceBrowser";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type InvoiceRow = Serialized<InvoiceListItemDto>;

export default async function FeesPage() {
  const session = await auth();
  const user = session!.user;
  const [page, summary] = await Promise.all([
    apiGet<{ items: InvoiceRow[]; nextCursor: string | null }>("/invoices"),
    apiGet<Serialized<InvoiceSummaryDto>>("/invoices/summary"),
  ]);
  const canManage = hasPermission(user.permissions, "fee.manage");
  const canApprove = hasPermission(user.permissions, "fee.approve");
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
        <PageHeader title={<>Fees &amp; Billing</>} subtitle={<>{canManage
              ? "All invoices in your school. Open one to record a payment."
              : "Invoices for your family. Open one to see the balance and payment history."}</>} />

        {canApprove && pending && pending.length > 0 && <PendingPayments payments={pending} />}

        {canManage && students && (
          <FeesAdmin students={students} items={feeItems ?? []} />
        )}

        {page === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your role does not include <code>fee.read</code>.</AlertDescription>
          </Alert>
        ) : (
          <InvoiceBrowser
            initial={page.items ?? []}
            initialCursor={page.nextCursor ?? null}
            summary={summary}
            canManage={canManage}
          />
        )}
      </div>
    </AppShell>
  );
}
