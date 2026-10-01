// =============================================================================
// Ledger integrity — invoices whose status disagrees with their payments
// =============================================================================
// An invoice's status is a label the app derives from its payments. Nothing in
// the database enforces it, and a direct write can leave it wrong for ever: a
// live invoice read PAID after the scholarship payment that paid it was deleted
// behind the app's back. This lists every such invoice on the platform, worst
// first, and offers the one safe correction — make the label say what the money
// says. Nothing here moves money.
// =============================================================================

import type { LedgerMismatchPageDto, Serialized } from "@sms/types";
import { LEDGER_MISMATCH_KINDS, LEDGER_MISMATCH_LABELS } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SweepButton } from "@/components/maintenance/SweepButton";
import { LedgerMismatchTable } from "@/components/operator/LedgerMismatchTable";

export const dynamic = "force-dynamic";

export default async function LedgerIntegrityPage({ searchParams }: { searchParams: { page?: string } }) {
  const session = await auth();
  const user = session!.user;
  // Redirect, not a hidden link: a typed URL should land somewhere useful.
  if (!hasPermission(user.permissions, "fee.reconcile.run")) redirect("/operator");

  const page = Math.max(1, Number(searchParams.page) || 1);
  const data = await apiGet<Serialized<LedgerMismatchPageDto>>(`/operator/ledger-integrity?page=${page}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Ledger integrity</>}
            subtitle={
              <>
                Invoices whose status disagrees with their payments, across every school. Checked nightly. A status is
                a label the platform derives from the money; this finds the labels that went wrong, and corrects them
                without touching a payment.
              </>
            }
          />
          <Link href="/operator" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Operator console
          </Link>
        </div>

        <SweepButton path="operator/ledger-integrity/run" label="Run the check now" help="Judges every billable invoice on the platform against its payments. Reports only; changes nothing." />

        {!data ? (
          // NULL is "could not ask", never "nothing wrong" — the page must not
          // read a failed request as a clean ledger.
          <Alert variant="destructive">
            <AlertTitle>The check could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that every invoice agrees with its payments. Try again, or run the check above.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {LEDGER_MISMATCH_KINDS.map((k) => (
                <Card key={k}>
                  <CardHeader className="pb-2">
                    <CardDescription>{LEDGER_MISMATCH_LABELS[k]}</CardDescription>
                    <CardTitle className={`tnum text-2xl ${data.byKind[k] > 0 && k !== "PARTIAL_MISLABELLED" ? "text-destructive" : ""}`}>
                      {data.byKind[k].toLocaleString()}
                    </CardTitle>
                  </CardHeader>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {data.total === 0
                    ? "Every invoice agrees with its payments"
                    : `${data.total.toLocaleString()} invoice${data.total === 1 ? "" : "s"} across ${data.schools} school${data.schools === 1 ? "" : "s"}`}
                </CardTitle>
                <CardDescription>
                  Worst first: marked paid while still owed (reminders have stopped), then marked open while settled
                  (a family may be chased for a bill they paid). Correcting one tells that school&apos;s finance staff.
                </CardDescription>
              </CardHeader>
              {data.total > 0 && (
                <CardContent className="p-0">
                  <LedgerMismatchTable rows={data.rows} />
                  {pages > 1 && (
                    <div className="flex items-center justify-between border-t px-4 py-2 text-sm">
                      <span className="text-muted-foreground">
                        Page {page} of {pages}
                      </span>
                      <span className="flex gap-2">
                        {page > 1 && <Link href={`/operator/ledger-integrity?page=${page - 1}`}>← Previous</Link>}
                        {page < pages && <Link href={`/operator/ledger-integrity?page=${page + 1}`}>Next →</Link>}
                      </span>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
