import { ThemeToggle } from "@/components/shell/ThemeToggle";
import type { ReportCardAttestationDto, Serialized } from "@sms/types";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

// PUBLIC page — no authentication, because the audience is whoever is HOLDING
// the card and was not party to issuing it: a receiving school, an employer, a
// parent sent a page by somebody else.
//
// It shows the marks deliberately. Verification exists to catch a doctored card,
// and the only shape in which a person can do that is one they can compare
// against the page in front of them — a digest cannot be recomputed by eye. The
// reader already holds the card, so nothing here tells them anything new; the
// code is printed on the card and nowhere else.

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export default async function VerifyCardPage({
  params,
}: {
  params: { slug: string; code: string };
}) {
  let data: Serialized<ReportCardAttestationDto> | null = null;
  try {
    const res = await fetch(`${API_BASE}/public/report-card/verify/${params.slug}/${params.code}`, {
      cache: "no-store",
    });
    if (res.ok) data = await res.json();
  } catch {
    /* API unreachable — render the not-found state, which says the same thing */
  }

  // THE ISSUING SCHOOL'S CLOCK, off the payload. A public page has no session to
  // read a region from, and formatting on the reader's own clock dates a Lagos
  // card a day early for anyone west of UTC.
  const region = data
    ? { locale: data.schoolLocale, timezone: data.schoolTimezone, currency: "" }
    : undefined;

  return (
    <main className="relative mx-auto min-h-screen max-w-2xl bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <h1 className="pr-14 text-2xl font-semibold tracking-tight">Report card check</h1>

      {!data ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-5">
          <p className="text-sm font-medium">No card matches that code.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Check the code on the card and try again — it is twelve characters, in three groups of
            four. If it still does not match, the card was not issued by this school.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-5">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              This is a genuine record issued by {data.schoolName}.
            </p>
            <p className="mt-2 text-sm">
              Approved by <span className="font-medium">{data.approvedByName}</span> (
              {data.approvedByRole}) on {shortDate(data.approvedAt, region)}.
            </p>
            {/* The one thing a holder cannot otherwise know. A card reissued
                after a correction leaves earlier printouts looking identical. */}
            <p className="mt-2 text-xs text-muted-foreground">
              Issue {data.version}
              {data.version > 1
                ? " — this card has been reissued. If your copy shows a lower issue number, it has been superseded."
                : ""}
              , dated {shortDate(data.issuedAt, region)}.
            </p>
          </div>

          <div className="mt-5 rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">Compare against the card you are holding</h2>
            <div className="mt-3">
              <Row label="Student" value={data.studentName} />
              {data.className && <Row label="Class" value={data.className} />}
              <Row
                label="Term"
                value={[data.termName, data.sessionName].filter(Boolean).join(" · ")}
              />
              <Row
                label="Term average"
                value={
                  data.termAverage === null
                    ? "—"
                    : `${data.termAverage}${data.termGrade ? ` (${data.termGrade})` : ""}`
                }
              />
            </div>

            <h3 className="mt-5 text-sm font-semibold">Subjects as issued</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-medium">Subject</th>
                    <th className="py-1.5 text-right font-medium">Total</th>
                    <th className="py-1.5 text-right font-medium">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {data.subjects.map((s) => (
                    <tr key={s.subject} className="border-b border-border/60 last:border-0">
                      <td className="py-1.5">{s.subject}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.total ?? "—"}</td>
                      <td className="py-1.5 text-right font-medium">{s.grade ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Anything on your copy that differs from this page was not issued by the school.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
