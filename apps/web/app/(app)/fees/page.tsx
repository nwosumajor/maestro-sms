import type { InvoiceListItemDto, InvoiceSummaryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FeesAdmin } from "@/components/fees/FeesAdmin";
import { PendingPayments, type PendingPage } from "@/components/fees/PendingPayments";
import { InvoiceBrowser } from "@/components/fees/InvoiceBrowser";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type InvoiceRow = Serialized<InvoiceListItemDto>;

export default async function FeesPage({
  searchParams,
}: {
  searchParams?: Promise<{ pendingPage?: string }>;
}) {
  // The approver queue's page rides the URL, so a deep page can be linked.
  const sp = (await searchParams) ?? {};
  const session = await auth();
  const user = session!.user;
  // /invoices and /invoices/summary both require fee.read; without this the
  // page loaded for roles that hold none of it and asked twice anyway.
  if (!hasPermission(user.permissions, "fee.read")) redirect("/dashboard");

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
  const pendingPage = Number(sp.pendingPage) > 0 ? Number(sp.pendingPage) : 1;
  const pending = canApprove
    ? await apiGet<PendingPage>(`/fees/payments/pending${pendingPage > 1 ? `?page=${pendingPage}` : ""}`)
    : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="fees" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Fees &amp; Billing</>} subtitle={<>{canManage
              ? "All invoices in your school. Open one to record a payment."
              : "Invoices for your family. Open one to see the balance and payment history."}</>} />

        {canApprove && pending && pending.total > 0 && <PendingPayments page={pending} />}

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
