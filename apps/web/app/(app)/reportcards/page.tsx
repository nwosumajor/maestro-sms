import type { AcademicSessionDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { ReportCardConsole } from "@/components/reportcards/ReportCardConsole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type Named = { id: string; name: string };

/**
 * Print report cards for a class and a term.
 *
 * The capability was already complete in the API and had no front door: a card
 * for a PAST term could only be produced by finding the pupil, opening their
 * page, scrolling to a panel headed "Remarks" and changing a term selector
 * there. Nobody looks under Remarks to print a report card, and there was no way
 * to do a whole class at all.
 *
 * STAFF ONLY. A pupil and a parent read their own card on the gradebook page;
 * the server scopes every read anyway, but a class-and-term console is not a
 * screen that means anything to a family.
 */
export default async function ReportCardsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "grade.read")) redirect("/dashboard");
  const isStaff = !user.roles.includes("student") && !user.roles.includes("parent");
  if (!isStaff) redirect("/gradebook");

  const [sessions, classes] = await Promise.all([
    apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions"),
    apiGet<Named[]>("/classes/mine"),
  ]);

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="reportcards"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <PageHeader
            title={<>Report cards</>}
            subtitle={
              <>
                Print a class&rsquo;s report cards for any term. Each card is rendered from the marks published for
                that term, so a card printed today for a term that has ended reads the same as it did then.
              </>
            }
          />
          <Link href="/gradebook" className="text-sm text-muted-foreground hover:underline">
            ← Gradebook
          </Link>
        </div>

        {/* `apiGet` returns null for ANY failure. Reporting "no classes" for a
            failed read would send a head of year away believing there is
            nothing to print. */}
        {sessions === null || classes === null ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Could not load classes and terms</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-destructive">
                This is <strong>not</strong> a report that there is nothing to print. Reload and try again.
              </p>
            </CardContent>
          </Card>
        ) : classes.length === 0 || sessions.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nothing to print yet</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {classes.length === 0
                  ? "You do not supervise or teach a class, so there is no class to print for."
                  : "This school has no academic sessions or terms set up yet."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <ReportCardConsole classes={classes} sessions={sessions} />
        )}
      </div>
    </AppShell>
  );
}
