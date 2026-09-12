import type { ScholarshipApplicationDto, ScholarshipSchoolPageDto, Serialized } from "@sms/types";
import { money, dateTime, type DisplayRegion } from "@/lib/format";

// =============================================================================
// SchoolApplications — leadership's oversight table
// =============================================================================
// `scholarship.read` (board, principal, school_admin) put this section in the
// nav and a "Requests & decisions" tile on the dashboard, then showed a notice
// saying leadership could see their students' applications "here" — while the
// page fetched nothing for them. This is the view that notice promised.
//
// DRAFTs never arrive here: a draft belongs to the parent or teacher still
// writing it, and the platform sponsor's own queue excludes them too.
// =============================================================================

type App = Serialized<ScholarshipApplicationDto>;
/** The page, plus the status the caller asked for (so the dropdown can show it). */
type Page = Serialized<ScholarshipSchoolPageDto> & { status?: string };

/** Where a submitted request currently sits, in the chain's own language. */
const STAGE: Record<string, { label: string; tone: string }> = {
  SUBMITTED: { label: "With the class supervisor", tone: "bg-muted text-foreground" },
  SUPERVISOR_APPROVED: { label: "With the parent/guardian", tone: "bg-muted text-foreground" },
  PARENT_APPROVED: { label: "With the principal", tone: "bg-muted text-foreground" },
  PRINCIPAL_APPROVED: { label: "With the sponsor", tone: "bg-primary/10 text-primary" },
  UNDER_REVIEW: { label: "Sponsor reviewing", tone: "bg-primary/10 text-primary" },
  SHORTLISTED: { label: "Shortlisted", tone: "bg-primary/10 text-primary" },
  QUALIFIED: { label: "Qualified for the exam", tone: "bg-primary/10 text-primary" },
  AWARDED: { label: "Awarded", tone: "bg-[--accent-2]/15 text-[--accent-2]" },
  REJECTED: { label: "Not successful", tone: "bg-destructive/10 text-destructive" },
};

export function SchoolApplications({
  page,
  region,
}: {
  /** A PAGE, not an array. The headline figures used to be computed from the
   *  fetched rows: a five-year school holding 1,200 applications was shown
   *  "Submitted 500 / In progress 405 / Awarded 29" against a true
   *  1,200 / 980 / 60. A wrong number on an oversight screen is worse than a
   *  short list, because nothing about it looks short. */
  page: Page;
  region: DisplayRegion;
}) {
  const applications = page.items;
  if (page.total === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-sm font-medium">No submitted applications yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Students, parents and teachers raise these. One appears here as soon as it is submitted — drafts stay
          private to whoever is writing them.
        </p>
      </div>
    );
  }

  // COUNTED IN SQL over the whole school, never derived from the page below.
  const c = page.counts;
  const submitted = Object.values(c).reduce((a, b) => a + b, 0);
  const awardedCount = c.AWARDED ?? 0;
  const inProgress = submitted - awardedCount - (c.REJECTED ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Submitted", value: submitted },
          { label: "In progress", value: inProgress },
          { label: "Awarded", value: awardedCount },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className="text-lg font-semibold">{t.value}</div>
          </div>
        ))}
      </div>

      {/* REACH. The list is capped; these say what is behind it and get there.
          Both narrow in SQL — filtering the fetched page in the browser could
          only ever see the rows that survived the cap. */}
      <form method="GET" className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-xs text-muted-foreground" htmlFor="sch-status">Show</label>
        <select
          id="sch-status"
          name="status"
          defaultValue={page.status ?? ""}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Everything</option>
          {Object.entries(c)
            .filter(([k, n]) => n > 0 && k !== "DRAFT")
            .map(([k, n]) => (
              <option key={k} value={k}>{(STAGE[k]?.label ?? k)} ({n})</option>
            ))}
        </select>
        <button type="submit" className="h-8 rounded-md border border-border px-3 text-xs hover:bg-muted">
          Apply
        </button>
        <span className="text-xs text-muted-foreground">
          {page.total > page.shown
            ? `showing ${page.shown} of ${page.total}`
            : `${page.total} application${page.total === 1 ? "" : "s"}`}
        </span>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Programme</th>
              <th className="px-3 py-2 font-medium">Raised by</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 text-right font-medium">Award</th>
              <th className="px-3 py-2 font-medium">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((a) => {
              const stage = STAGE[a.status] ?? { label: a.status, tone: "bg-muted text-foreground" };
              return (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{a.studentName}</td>
                  <td className="px-3 py-2">{a.programTitle}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {a.applicantName}
                    <span className="ml-1 text-xs">({a.applicantRole.toLowerCase()})</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${stage.tone}`}>{stage.label}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {a.awardMinor != null ? money(a.awardMinor) : "—"}
                    {/* The bursar's question is not "how much" but "will it be
                        on an invoice". A held credit comes off the NEXT bill,
                        so an office chasing this term's balance needs to know
                        which of the two it is. */}
                    {a.disbursed && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {a.disbursementKind === "CREDIT" ? "held as credit" : "on an invoice"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{dateTime(a.createdAt, region)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Oversight only — the decisions belong to the class supervisor, the guardian, the principal and then the
        sponsor. Nothing on this page changes an application.
      </p>
    
      {/* A cap is only safe when the rest is reachable. */}
      {page.total > page.pageSize && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {page.page > 1 && (
            <a className="underline hover:text-foreground" href={`/scholarships?${new URLSearchParams({ ...(page.status ? { status: page.status } : {}), page: String(page.page - 1) })}`}>
              ← newer
            </a>
          )}
          <span>page {page.page} of {Math.max(1, Math.ceil(page.total / page.pageSize))}</span>
          {page.page * page.pageSize < page.total && (
            <a className="underline hover:text-foreground" href={`/scholarships?${new URLSearchParams({ ...(page.status ? { status: page.status } : {}), page: String(page.page + 1) })}`}>
              older →
            </a>
          )}
        </div>
      )}
</div>
  );
}
