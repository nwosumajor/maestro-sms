import type { FamilyOverviewDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { money, regionOf, shortDate } from "@/lib/format";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Overview = Serialized<FamilyOverviewDto>;


const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export default async function FamilyPage() {
  const session = await auth();
  const user = session!.user;
  // Gate matches this section's AppShell nav entry ("family.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "family.read")) redirect("/dashboard");
  // The SCHOOL's currency, from the session. A parent whose child is at a
  // Ghanaian or British school read their outstanding fees with a naira sign in
  // front, divided by 100 — this being the one page whose whole purpose is to
  // tell a family what they owe.
  const region = regionOf(user);
  const fees = (minor: number) => money(minor, region.currency, region.locale);
  // NULL IS NOT EMPTY, and here the two were the SAME rendering.
  //
  // A parent with no linked children gets 200 and `{ children: [] }` — the
  // service returns that explicitly and never 404s. So `null` from `apiGet` is
  // always something else: the API DECLINED to answer. Realistically a 403,
  // which is reachable because this page gates on the SESSION's permissions
  // while the API gates on the DB's, and those can disagree — the divergence is
  // documented, and a parent whose row says otherwise lands here.
  //
  // (Not a network blip: `apiGet` deliberately THROWS on an unreachable API, a
  // 5xx and a 429, precisely so none of them renders as "no data". Checked
  // rather than assumed — the first version of this comment said blip.)
  //
  // `?? { children: [] }` turned that refusal into the page's settled,
  // actionable statement: "Your account isn't linked to any students yet — ask
  // the school office to link you", in an INFO alert, so it reads as fact. It
  // sends a parent to ring the school about a link that already exists, on the
  // one page whose whole purpose is their own family.
  const overview = await apiGet<Overview>("/family/overview");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="family" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>My children</>} subtitle={<>Everything about your linked children in one place — published grades, attendance,
            discipline, tasks and fees. Open a child&apos;s name for their record: profile,
            emergency contacts and medical. Full detail lives on the{" "}
            <Link className="text-primary hover:underline" href="/gradebook">Grades</Link>,{" "}
            <Link className="text-primary hover:underline" href="/attendance">Attendance</Link> and{" "}
            <Link className="text-primary hover:underline" href="/fees">Fees</Link> pages.</>} />

        {overview === null ? (
          <Alert variant="destructive">
            <AlertTitle>Your children could not be loaded</AlertTitle>
            <AlertDescription>
              The school&apos;s system would not answer, so this is NOT a statement that you have no
              children linked. Reload the page; if it keeps happening, tell the school office that
              your account cannot read your family record.
            </AlertDescription>
          </Alert>
        ) : overview.children.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No linked children</AlertTitle>
            <AlertDescription>
              Your account isn&apos;t linked to any students yet — ask the school office to link you.
            </AlertDescription>
          </Alert>
        ) : (
          overview.children.map((c) => (
            <Card key={c.studentId}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <CardTitle className="text-base">
                  {/* Through to the child's RECORD — profile, emergency contacts and
                      medical. This hub deliberately links out to Grades/Attendance/
                      Fees but never named the record itself, so the only route to it
                      was a nav entry labelled "Students", which read like the whole
                      school's roster. */}
                  <Link className="hover:underline" href={`/students/${c.studentId}`}>
                    {c.studentName}
                  </Link>
                  {c.className && <span className="text-muted-foreground"> · {c.className}</span>}
                  {/* SAY THAT THEY HAVE LEFT.

                      A departed pupil has no ACTIVE enrolment, so `className`
                      goes null — which is exactly what a pupil whose class was
                      never set looks like. Measured live on a real exit: the
                      card showed the child with a blank class, and a parent had
                      no way to tell that from an unassigned one while the
                      school's own record said they had gone.

                      The guardian link is retained deliberately (a leaver keeps
                      their guardians, and the family still needs invoices,
                      documents and report cards), so this card has to say which
                      it is or it presents a former pupil as a current one. */}
                  {c.exitedAt && (
                    <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                      Left the school on {shortDate(c.exitedAt, region)}
                    </span>
                  )}
                </CardTitle>
                {c.grades?.sessionAverage != null && (
                  <Badge>Session avg {c.grades.sessionAverage}</Badge>
                )}
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</p>
                  {c.attendance.total === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No registers taken yet.</p>
                  ) : (
                    <>
                      <p className="mt-1 text-2xl font-semibold">{c.attendance.pct}%</p>
                      <p className="text-xs text-muted-foreground">
                        {c.attendance.present} present · {c.attendance.late} late · {c.attendance.absent} absent
                        {c.attendance.excused > 0 ? ` · ${c.attendance.excused} excused` : ""}
                      </p>
                    </>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Grades{c.grades ? ` — ${c.grades.sessionName}` : ""}
                  </p>
                  {!c.grades || c.grades.termAverages.every((t) => t.average === null) ? (
                    <p className="mt-1 text-sm text-muted-foreground">No published results yet.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.grades.termAverages.map((t) => (
                        <li key={t.termId} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">{t.termName}</span>
                          <span className="font-medium">{t.average ?? "—"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Discipline</p>
                  {c.discipline.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No records.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.discipline.map((d) => (
                        <li key={d.id} className="flex justify-between gap-2">
                          <span className="truncate">{d.subject}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{d.status.replace(/_/g, " ").toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tasks &amp; fees</p>
                  {c.tasks.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">No assigned tasks.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {c.tasks.map((t) => (
                        <li key={t.id} className="flex justify-between gap-2">
                          <span className="truncate">{t.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t.assignmentStatus.replace(/_/g, " ").toLowerCase()}{t.dueAt ? ` · due ${date(t.dueAt)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-sm">
                    {c.fees.outstandingMinor > 0 ? (
                      <>
                        <span className="font-medium text-destructive">{fees(c.fees.outstandingMinor)}</span>
                        <span className="text-muted-foreground"> outstanding on {c.fees.unpaidInvoices} invoice{c.fees.unpaidInvoices === 1 ? "" : "s"}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">No outstanding fees.</span>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </AppShell>
  );
}
