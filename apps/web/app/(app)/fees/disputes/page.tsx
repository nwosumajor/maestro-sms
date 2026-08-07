import type { PaymentDisputeDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DisputeRespondForm } from "@/components/fees/DisputeRespondForm";
import { money, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type Dispute = Serialized<PaymentDisputeDto>;

const STATUS_STYLE: Record<Dispute["status"], string> = {
  OPEN: "bg-destructive/15 text-destructive",
  RESPONDED: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  WON: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  LOST: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: Dispute["status"] }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status}</span>
  );
}

export default async function DisputesPage() {
  const session = await auth();
  const user = session!.user;
  // fee.manage, not fee.read: the list is school-wide finance-internal data.
  if (!hasPermission(user.permissions, "fee.manage")) redirect("/dashboard");
  // NOT `?? []`. "No disputes recorded" is a statement about money that a
  // finance officer acts on — it is the sentence that says nobody is contesting
  // a payment and there is no deadline to meet. A failed read must not be able
  // to produce it, so null (couldn't load) stays distinct from [] (none).
  const disputes = await apiGet<Dispute[]>("/fees/disputes");
  const open = disputes?.filter((d) => d.status === "OPEN").length ?? 0;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="fees" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader
            title={<>Payment disputes</>}
            subtitle={
              <>
                Chargebacks raised at the payment gateway. Respond before each deadline — an unanswered dispute is
                lost by default.
              </>
            }
          />
          <Link href="/fees/reports" className="text-sm text-muted-foreground hover:underline">
            ← Finance reports
          </Link>
        </div>

        {disputes === null ? (
          <Card>
            <CardContent className="py-8 text-sm">
              <p className="font-medium text-destructive">Couldn&apos;t load disputes</p>
              <p className="mt-1 text-muted-foreground">
                This is a failure to load — not a report that there are none. Do not treat it as &ldquo;nothing to
                respond to&rdquo;; an unanswered dispute is lost by default. Please refresh.
              </p>
            </CardContent>
          </Card>
        ) : disputes.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              No disputes recorded. If a payer contests a card payment, it appears here.
            </CardContent>
          </Card>
        ) : (
          <>
            {open > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {open} open dispute{open === 1 ? "" : "s"} awaiting a response.
              </div>
            )}
            <div className="space-y-4">
              {disputes.map((d) => (
                <Card key={d.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        {money(d.amountMinor, d.currency)}{" "}
                        <span className="font-normal text-muted-foreground">· ref {d.transactionReference}</span>
                      </CardTitle>
                      <StatusChip status={d.status} />
                    </div>
                    <CardDescription>
                      Opened {shortDate(d.createdAt)}
                      {d.category ? <> · {d.category}</> : null}
                      {d.dueAt ? <> · evidence deadline {shortDate(d.dueAt)}</> : null}
                      {d.invoiceId ? (
                        <>
                          {" "}
                          ·{" "}
                          <Link href={`/fees/${d.invoiceId}`} className="text-primary hover:underline">
                            view invoice
                          </Link>
                        </>
                      ) : null}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {d.responseNote && (
                      <p>
                        <span className="text-muted-foreground">Response recorded ({shortDate(d.respondedAt)}):</span>{" "}
                        {d.responseNote}
                      </p>
                    )}
                    {d.resolution && (
                      <p className="text-muted-foreground">
                        Resolution: {d.resolution} ({shortDate(d.resolvedAt)})
                      </p>
                    )}
                    {d.status === "OPEN" && <DisputeRespondForm disputeId={d.id} />}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
