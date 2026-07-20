// Message-credit (SMS/WhatsApp) oversight — the super_admin's cross-tenant view
// of every school's prepaid credit balance, with a per-school ledger drill-down
// and a comp/debit lever. Reached via the "Message credits →" quick link on
// /operator (same lightweight pattern as /operator/schools — no AppShell nav
// entry of its own).

import type { MessageCreditBalancePageDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MessageCreditFilterBar } from "@/components/operator/MessageCreditFilterBar";
import { MessageCreditRow } from "@/components/operator/MessageCreditRow";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type CreditPage = Serialized<MessageCreditBalancePageDto>;

export default async function MessageCreditsPage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");
  const canAdjust = hasPermission(user.permissions, "platform.subscription.manage");

  const q = searchParams.q ?? "";
  const pageNum = Math.max(1, Number(searchParams.page) || 1);
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  query.set("page", String(pageNum));

  const data = await apiGet<CreditPage>(`/operator/message-credits?${query.toString()}`);
  const rows = data?.rows ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Message credits</>}
          subtitle={<>Every school&apos;s prepaid SMS/WhatsApp credit balance — schools buy their own bundles
              self-serve on their Billing page; this is cross-tenant oversight, plus a comp/debit lever for
              support cases (a gateway outage, a duplicate purchase, goodwill).</>}
        />

        {data && <MessageCreditFilterBar q={q} page={data.page} pageSize={data.pageSize} total={data.total} />}

        {!data ? (
          <Alert variant="destructive">
            <AlertTitle>Unavailable</AlertTitle>
            <AlertDescription>
              This view needs the platform&apos;s privileged database configuration (DATABASE_MIGRATE_URL /
              DATABASE_RETENTION_URL), same as the operator directory and analytics — it isn&apos;t set here.
            </AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No schools found</AlertTitle>
            <AlertDescription>Try a different search.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <MessageCreditRow key={row.schoolId} row={row} canAdjust={canAdjust} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
