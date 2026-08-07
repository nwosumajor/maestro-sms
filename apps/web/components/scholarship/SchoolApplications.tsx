import type { ScholarshipApplicationDto, Serialized } from "@sms/types";
import { money, dateTime } from "@/lib/format";

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

export function SchoolApplications({ applications }: { applications: App[] }) {
  if (applications.length === 0) {
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

  const awarded = applications.filter((a) => a.status === "AWARDED");
  const open = applications.filter((a) => !["AWARDED", "REJECTED"].includes(a.status));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Submitted", value: applications.length },
          { label: "In progress", value: open.length },
          { label: "Awarded", value: awarded.length },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className="text-lg font-semibold">{t.value}</div>
          </div>
        ))}
      </div>

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
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{dateTime(a.createdAt)}</td>
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
    </div>
  );
}
