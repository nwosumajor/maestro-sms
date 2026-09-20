import Link from "next/link";
import type { LmsLiveSessionPageDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveClassTable } from "@/components/lms/LiveClassTable";
import { SweepButton } from "@/components/maintenance/SweepButton";

export const dynamic = "force-dynamic";

/**
 * Live classes, across every course the reader can see.
 *
 * The per-class panel is still the right view from inside a class. This page
 * answers a different question — "what is on, and what can I go back and watch"
 * — which no screen could ask before, because live sessions existed only as a
 * panel on one class at a time.
 *
 * THE FILTERS RUN ON THE SERVER. A search that narrows the fetched page only
 * ever sees the rows that survived the cap, which is how a reader comes to
 * believe a term holds three recordings when it holds forty.
 */
export default async function LiveClassesPage({
  searchParams,
}: {
  searchParams?: Promise<{
    q?: string;
    from?: string;
    to?: string;
    recorded?: string;
    page?: string;
    /** Narrowed to ONE class, which is how the per-class panel hands its
     *  reader over here for the sessions it could not fit. The API has taken
     *  this filter since the diary was built; no screen could send it. */
    classId?: string;
  }>;
}) {
  const sp = (await searchParams) ?? {};
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "lms.content.read")) redirect("/dashboard");

  const query = new URLSearchParams();
  if (sp.q) query.set("q", sp.q);
  if (sp.from) query.set("from", sp.from);
  if (sp.to) query.set("to", sp.to);
  if (sp.recorded === "1") query.set("recorded", "1");
  if (sp.page) query.set("page", sp.page);
  if (sp.classId) query.set("classId", sp.classId);
  const qs = query.toString();

  const page = await apiGet<Serialized<LmsLiveSessionPageDto>>(`/live${qs ? `?${qs}` : ""}`);
  // Name the narrowing and offer the way out of it. A filtered list that looks
  // like the whole list is how a reader concludes a course has three sessions.
  const onlyClass = sp.classId ? page?.rows[0]?.className ?? null : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="live-classes" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Live classes</>}
          subtitle={
            <>
              Every live class for the courses you can see — join one that is on now, or play back a
              recorded lesson. Recordings play here and are not offered as downloads.
            </>
          }
        />
        {/* The nightly purge, on demand — for the day somebody asks whether
            last year's recordings are actually gone and the answer has to be
            yes rather than "tonight". School-scoped for school staff. */}
        {hasPermission(user.permissions, "lms.content.write") && (
          <SweepButton
            path="live-recordings/retention/run"
            label="Remove expired recordings now"
            help="Recordings are removed at the end of the academic session they were taught in. This runs that clear-out for your school now."
          />
        )}
        {/* THE SAME SENTENCE THE PER-CLASS PANEL SHOWS, because it is the same
            rule over the same rows — and the panel having it while this page
            did not is the sibling asymmetry the fix itself was about. */}
        {page?.narrowedToMySubjects === false && (
          <p className="text-sm text-muted-foreground">
            Showing every subject in your classes. Your subject choices for this term haven&rsquo;t been
            approved yet — once they are, you&rsquo;ll only see the lessons for the subjects you take.
          </p>
        )}
        {sp.classId && (
          <p className="text-sm text-muted-foreground">
            Showing {onlyClass ?? "one class"} only.{" "}
            <Link href="/live-classes" className="underline underline-offset-4">
              Show every class
            </Link>
            .
          </p>
        )}
        <LiveClassTable
          initial={page ?? { rows: [], total: 0, page: 1, pageSize: 25, narrowedToMySubjects: null }}
          filters={{ q: sp.q ?? "", from: sp.from ?? "", to: sp.to ?? "", recorded: sp.recorded === "1" }}
          canManage={hasPermission(user.permissions, "lms.content.write")}
        />
      </div>
    </AppShell>
  );
}
