import type { AdmissionApplicationPageDto, DocumentRequirementDto, Serialized } from "@sms/types";
import { MODULES } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdmissionsReview, type Application } from "@/components/admissions/AdmissionsReview";
import { FormFeeCard } from "@/components/admissions/FormFeeCard";
import { PageHeader } from "@/components/shell/PageHeader";
import { RequirementsEditor } from "@/components/documents/RequirementsEditor";

export const dynamic = "force-dynamic";

const STATUSES = ["NEW", "REVIEWING", "ACCEPTED", "REJECTED"] as const;

export default async function AdminAdmissionsPage({
  searchParams,
}: {
  searchParams?: { status?: string; q?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "admission.review")) redirect("/dashboard");
  // Only the registrar tier may shape the document list, so only ask when they
  // can — a 403 read would render as "this school asks for nothing", which is
  // the opposite of the truth.
  const canManageDocs = hasPermission(user.permissions, "student.profile.write");
  // Putting a child on the roll is a narrower authority than deciding their
  // application — hr_manager holds admission.review and must not hold this.
  const canEnrol = hasPermission(user.permissions, "class.write");
  const qs = new URLSearchParams();
  for (const key of ["status", "q", "page"] as const) {
    const v = searchParams?.[key];
    if (v) qs.set(key, v);
  }
  // ADMISSIONS is a ULTIMATE add and this page is reachable on permission
  // alone. Without the module every call below answers 404, `apiGet` returns
  // null for that exactly as for a real failure, and the page rendered a RED
  // alert reading "Applications could not be loaded ... applicants are waiting
  // on a decision". Nobody was waiting and reloading could never help.
  //
  // Gate BEFORE fetching, as the dashboard now does for analytics: a module the
  // plan does not include is not a failure to report.
  const hasAdmissions = !user.modules || user.modules.includes(MODULES.ADMISSIONS);
  const [appPage, formFee, requirements, classes] = await Promise.all([
    // Every filter narrows the QUERY. The list is paged, so the family that
    // applied first is reachable by status, by name or by stepping back a page
    // — it used to be the 200 most recent and nothing else.
    hasAdmissions
      ? apiGet<Omit<Serialized<AdmissionApplicationPageDto>, "items"> & { items: Application[] }>(
          `/admissions${qs.toString() ? `?${qs}` : ""}`,
        )
      : Promise.resolve(null),
    hasAdmissions ? apiGet<{ formFeeMinor: number }>("/admissions/settings/form-fee") : Promise.resolve(null),
    canManageDocs
      ? apiGet<Serialized<DocumentRequirementDto>[]>("/documents/requirements?scope=STUDENT_ADMISSION")
      : Promise.resolve(null),
    // For the class picker when enrolling an accepted applicant. Only fetched
    // for somebody who may actually enrol — an unauthorised read would render
    // an empty picker rather than an error.
    canEnrol ? apiGet<{ id: string; name: string }[]>("/classes/mine") : Promise.resolve(null),
  ]);

  const apps = appPage === null ? null : appPage.items;
  const total = appPage?.total ?? 0;
  const page = appPage?.page ?? 1;
  const pageSize = appPage?.pageSize ?? 50;
  // Counted in SQL, school-wide. NEW/REVIEWING is a family still waiting for an
  // answer, and those are exactly the rows that age off a newest-first cap.
  const undecided = appPage?.undecidedTotal ?? 0;
  const filtered = Boolean(searchParams?.status || searchParams?.q);
  const pageHref = (n: number) => {
    const pr = new URLSearchParams();
    if (searchParams?.status) pr.set("status", searchParams.status);
    if (searchParams?.q) pr.set("q", searchParams.q);
    if (n > 1) pr.set("page", String(n));
    return pr.toString() ? `/admin/admissions?${pr}` : "/admin/admissions";
  };
  const filterHref = (st?: (typeof STATUSES)[number]) => {
    const pr = new URLSearchParams();
    if (st) pr.set("status", st);
    if (searchParams?.q) pr.set("q", searchParams.q);
    return pr.toString() ? `/admin/admissions?${pr}` : "/admin/admissions";
  };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Admissions</>} subtitle={<>Parent enrolment applications, quarantined from student data until accepted. Each is reviewed by
              School admin → HR → Principal (a different person per stage); schedule the entrance exam and the
              applicant is emailed on acceptance. The public form lives at <code>/enroll</code>.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {formFee && (
          <FormFeeCard initialMinor={formFee.formFeeMinor} canManage={hasPermission(user.permissions, "fee.manage")} />
        )}
        {/* What families are asked to send. Editable, because schools differ and
            adding one should be a row rather than a release. */}
        {canManageDocs && requirements !== null && (
          <RequirementsEditor
            scope="STUDENT_ADMISSION"
            initial={requirements}
            title="Documents asked of families"
          />
        )}
        {/* School-wide, so it renders whatever the current filter shows — a
            filter that happens to match nothing must not be able to hide the
            fact that a family is still waiting for an answer. */}
        {undecided > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
            {undecided} application{undecided === 1 ? "" : "s"} awaiting a decision
            {filtered ? " (school-wide, not just this filter)" : ""}.{" "}
            {!searchParams?.status && (
              <Link href={filterHref("NEW")} className="underline underline-offset-2">
                Show new
              </Link>
            )}
          </div>
        )}

        {/* Every filter narrows the QUERY, never a page of results. */}
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

        <form action="/admin/admissions" className="flex flex-wrap items-center gap-2">
          {searchParams?.status && <input type="hidden" name="status" value={searchParams.status} />}
          <input
            type="search"
            name="q"
            aria-label="Search applications by child, applicant or email"
            defaultValue={searchParams?.q ?? ""}
            placeholder="Search by child, applicant or email…"
            className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm"
          />
          <button type="submit" className="h-9 rounded-md border border-border px-3 text-sm hover:bg-accent">
            Search
          </button>
          {searchParams?.q && (
            <Link
              href={searchParams.status ? `/admin/admissions?status=${searchParams.status}` : "/admin/admissions"}
              className="text-sm underline underline-offset-2"
            >
              Clear
            </Link>
          )}
        </form>

        {/* A failed read used to render "No applications — none recorded for
            this school", and an admissions officer who believes that stops
            looking. A family waiting on a decision is the cost. */}
        {!hasAdmissions ? (
          // NOT a failure, and not "no applications": the school does not have
          // the module, so there is no public form and no queue to be clear.
          <Alert variant="info">
            <AlertTitle>Admissions is not part of your plan</AlertTitle>
            <AlertDescription>
              The public application form is not open for your school, so there are no applications to review. Ask your
              administrator about adding Admissions if you would like to take enrolments online.
            </AlertDescription>
          </Alert>
        ) : apps === null ? (
          <Alert variant="destructive">
            <AlertTitle>Applications could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that none were submitted. Reload before treating the queue as clear —
              applicants are waiting on a decision.
            </AlertDescription>
          </Alert>
        ) : apps.length === 0 ? (
          filtered ? (
            <Alert variant="info">
              <AlertTitle>No applications match this filter</AlertTitle>
              <AlertDescription>Clear it to see the school&apos;s full admissions history.</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="info"><AlertTitle>No applications</AlertTitle><AlertDescription>None recorded for this school.</AlertDescription></Alert>
          )
        ) : (
          <AdmissionsReview apps={apps} classes={classes ?? []} canEnrol={canEnrol} />
        )}

        {/* What is SHOWN out of what MATCHES. A truncated list reads as the
            complete queue, and an admissions officer who believes it stops
            looking — with a family waiting on the other side. */}
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
