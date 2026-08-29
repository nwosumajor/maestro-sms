import type { DisputeStatus, PaymentDisputeDto, PaymentDisputePageDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DisputeRespondForm } from "@/components/fees/DisputeRespondForm";
import { money, regionOf, shortDate } from "@/lib/format";

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

const STATUSES: DisputeStatus[] = ["OPEN", "RESPONDED", "WON", "LOST"];

export default async function DisputesPage({
  searchParams,
}: {
  searchParams?: { status?: string; q?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // Dates follow the SCHOOL's timezone, not the platform's.
  const region = regionOf(user);
  // fee.manage, not fee.read: the list is school-wide finance-internal data.
  if (!hasPermission(user.permissions, "fee.manage")) redirect("/dashboard");
  const qs = new URLSearchParams();
  for (const key of ["status", "q", "page"] as const) {
    const v = searchParams?.[key];
    if (v) qs.set(key, v);
  }
  // NOT `?? []`. "No disputes recorded" is a statement about money that a
  // finance officer acts on — it is the sentence that says nobody is contesting
  // a payment and there is no deadline to meet. A failed read must not be able
  // to produce it, so null (couldn't load) stays distinct from [] (none).
  const data = await apiGet<Serialized<PaymentDisputePageDto>>(
    `/fees/disputes${qs.toString() ? `?${qs}` : ""}`,
  );
  const disputes = data === null ? null : data.items;
  const total = data?.total ?? 0;
  const page = data?.page ?? 1;
  const pageSize = data?.pageSize ?? 50;
  // Counted in SQL, school-wide. It used to be a memory filter over the 200 most
  // recent rows — so an OPEN dispute older than those did not appear in the
  // banner that exists to chase it, and ageing is exactly what makes one urgent.
  const open = data?.openTotal ?? 0;
  const filtered = Boolean(searchParams?.status || searchParams?.q);
  const pageHref = (n: number) => {
    const pr = new URLSearchParams();
    if (searchParams?.status) pr.set("status", searchParams.status);
    if (searchParams?.q) pr.set("q", searchParams.q);
    if (n > 1) pr.set("page", String(n));
    return pr.toString() ? `/fees/disputes?${pr}` : "/fees/disputes";
  };
  const filterHref = (st?: DisputeStatus) => {
    const pr = new URLSearchParams();
    if (st) pr.set("status", st);
    if (searchParams?.q) pr.set("q", searchParams.q);
    return pr.toString() ? `/fees/disputes?${pr}` : "/fees/disputes";
  };

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

        {/* Every filter narrows the QUERY. The list is paged, so an older
            dispute is reachable by status, by reference, or by stepping back a
            page — it used to be the 200 most recent and nothing else. */}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={filterHref()}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${!searchParams?.status ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            All
          </Link>
          {STATUSES.map((st) => (
            <Link
              key={st}
              href={filterHref(st)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${searchParams?.status === st ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
            >
              {st}
            </Link>
          ))}
        </div>

        <form action="/fees/disputes" className="flex flex-wrap items-center gap-2">
          {searchParams?.status && <input type="hidden" name="status" value={searchParams.status} />}
          <input
            type="search"
            name="q"
            aria-label="Search disputes by reference"
            defaultValue={searchParams?.q ?? ""}
            placeholder="Search by gateway reference or dispute id…"
            className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm"
          />
          <button type="submit" className="h-9 rounded-md border border-border px-3 text-sm hover:bg-accent">
            Search
          </button>
          {searchParams?.q && (
            <Link
              href={searchParams.status ? `/fees/disputes?status=${searchParams.status}` : "/fees/disputes"}
              className="text-sm underline underline-offset-2"
            >
              Clear
            </Link>
          )}
        </form>

        {/* School-wide, so it renders whatever the current filter shows. A
            filter that happens to match nothing must not be able to hide the
            fact that something is waiting on a response. */}
        {open > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {open} open dispute{open === 1 ? "" : "s"} awaiting a response
            {filtered ? " (school-wide, not just this filter)" : ""}.{" "}
            {!searchParams?.status && (
              <Link href={filterHref("OPEN")} className="underline underline-offset-2">
                Show them
              </Link>
            )}
          </div>
        )}

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
              {filtered
                ? "No disputes match this filter. Clear it to see the school's full dispute history."
                : "No disputes recorded. If a payer contests a card payment, it appears here."}
            </CardContent>
          </Card>
        ) : (
          <>
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
                      Opened {shortDate(d.createdAt, region)}
                      {d.category ? <> · {d.category}</> : null}
                      {d.dueAt ? <> · evidence deadline {shortDate(d.dueAt, region)}</> : null}
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
                        <span className="text-muted-foreground">Response recorded ({shortDate(d.respondedAt, region)}):</span>{" "}
                        {d.responseNote}
                      </p>
                    )}
                    {d.resolution && (
                      <p className="text-muted-foreground">
                        Resolution: {d.resolution} ({shortDate(d.resolvedAt, region)})
                      </p>
                    )}
                    {d.status === "OPEN" && <DisputeRespondForm disputeId={d.id} />}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}

        {/* What is SHOWN out of what MATCHES. Without it a truncated list reads
            as the complete answer — and on a permanent financial record that is
            the difference between "no chargebacks" and "none in the last 200". */}
        {total > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
              {filtered ? " matching" : ""}
            </span>
            {total > pageSize && (
              <span className="flex items-center gap-3">
                {page > 1 && (
                  <Link href={pageHref(page - 1)} className="underline underline-offset-2">Previous</Link>
                )}
                <span>Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span>
                {page * pageSize < total && (
                  <Link href={pageHref(page + 1)} className="underline underline-offset-2">Next</Link>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
