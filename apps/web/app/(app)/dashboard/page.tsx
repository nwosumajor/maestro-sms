import type {
  AnalyticsOverviewDto,
  CalendarEventDto,
  ClassDto,
  GamesAnalyticsDto,
  NotificationInboxDto,
  PlatformAnalyticsDto,
  Serialized,
  WorkflowSummaryDto,
} from "@sms/types";
import Link from "next/link";
import {
  BellIcon,
  BookOpenIcon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  ClipboardCheckIcon,
  CreditCardIcon,
  FolderIcon,
  Gamepad2Icon,
  GraduationCapIcon,
  MessageSquareIcon,
  MonitorCheckIcon,
  AwardIcon,
  BriefcaseIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";
import { PlatformAnalytics } from "@/components/operator/PlatformAnalytics";
import { GamesAnalytics } from "@/components/operator/GamesAnalytics";

export const dynamic = "force-dynamic";

type WorkflowDto = Serialized<WorkflowSummaryDto>;
type Overview = Serialized<AnalyticsOverviewDto>;
type Inbox = Serialized<NotificationInboxDto>;
type Ev = Serialized<CalendarEventDto>;

// =============================================================================
// The role console — "today's page of the register".
// One signature element (the ruled day-ledger header with the red margin rule);
// everything below stays calm: a ledger KPI strip, the role's real quick
// actions, and two live feeds. All data reads are null-safe: a missing
// permission renders a smaller console, never an error.
// =============================================================================

// Deterministic Lagos-time formatting (matches the app's pinned-TZ convention).
const lagosNow = () => new Date();
const HOUR_FMT = new Intl.DateTimeFormat("en-NG", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" });
const DAY_FMT = new Intl.DateTimeFormat("en-NG", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Africa/Lagos",
});

function greeting(): string {
  const h = Number(HOUR_FMT.format(lagosNow()));
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Compact relative time for the activity feed ("4h ago"). */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : shortDate(iso);
}

// Notification-type severity dot — matches the inbox's own colour language.
function typeDot(type: string): string {
  if (/ABSENCE|ALERT|OVERDUE|REJECT/i.test(type)) return "bg-severity-high-fg";
  if (/PAYMENT|RECEIPT|AWARD|APPROVED|SCHOLARSHIP/i.test(type)) return "bg-brand2";
  return "bg-primary";
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex-1 basis-40 border-border/60 px-5 py-4 transition-colors hover:bg-accent/50 sm:border-l first:sm:border-l-0"
    >
      <p className="eyebrow text-[0.62rem]">{label}</p>
      <p className="tnum mt-1.5 font-display text-[1.7rem] font-semibold leading-none tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {sub ?? " "}
        <span aria-hidden className="ml-1 inline-block translate-x-0 text-primary opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">→</span>
      </p>
    </Link>
  );
}

function Action({ icon: Icon, label, href, hint }: { icon: LucideIcon; label: string; href: string; hint: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3.5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elevated"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold tracking-tight">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </Link>
  );
}

export default async function DashboardPage() {
  const session = await auth();
  const user = session!.user;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(user.permissions, p);
  const mod = (m: string) => !user.modules || user.modules.includes(m);
  const firstName = (user.name ?? "there").split(" ")[0];

  // The platform owner has no tenant data — their console is the cross-tenant
  // business overview (management lives on the Operator console).
  if (can("platform.tenants.read")) {
    const [analytics, games] = await Promise.all([
      apiGet<Serialized<PlatformAnalyticsDto>>("/operator/analytics"),
      apiGet<Serialized<GamesAnalyticsDto>>("/operator/games-analytics"),
    ]);
    return (
      <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="dashboard" permissions={user.permissions}>
        <div className="space-y-6">
          <PageHeader
            eyebrow={DAY_FMT.format(lagosNow())}
            title={<>{greeting()}, {firstName}.</>}
            subtitle={<>Business health across every customer school — management lives on the Operator console.</>}
            actions={<Link href="/operator"><Button variant="outline">Operator console →</Button></Link>}
          />
          <PlatformAnalytics data={analytics ?? null} />
          <GamesAnalytics data={games ?? null} />
        </div>
      </AppShell>
    );
  }

  // Role console data — every read is optional; nulls shrink the page gracefully.
  const [overview, workflows, classes, inbox, events] = await Promise.all([
    apiGet<Overview>("/analytics/overview"),
    apiGet<WorkflowDto[]>("/workflows"),
    apiGet<ClassDto[]>("/classes/mine"),
    apiGet<Inbox>("/notifications"),
    apiGet<Ev[]>("/events"),
  ]);

  const pending = (workflows ?? []).filter((w) => w.state === "PENDING_REVIEW").length;
  const unread = inbox?.unread ?? 0;
  const recent = (inbox?.items ?? []).slice(0, 6);
  const upcoming = (events ?? [])
    .filter((e) => new Date(e.startsAt).getTime() >= Date.now() - 24 * 3600 * 1000)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    .slice(0, 5);

  // --- KPI strip: pick the four figures this role actually steers by ---------
  const isFamily = overview?.scope === "family";
  const att = overview?.attendance?.ratePct;
  const stats: { label: string; value: string; sub?: string; href: string }[] = [];
  if (overview?.operations?.students != null)
    stats.push({ label: "Students", value: overview.operations.students.toLocaleString(), sub: "on the register", href: "/students" });
  if ((classes ?? []).length > 0 || can("class.read"))
    stats.push({ label: isFamily ? "Classes" : "My classes", value: String((classes ?? []).length), sub: "this session", href: "/classes" });
  if (att != null)
    stats.push({ label: "Attendance", value: `${att}%`, sub: isFamily ? "your record" : "school-wide", href: "/attendance" });
  if (overview?.fees && can("fee.read"))
    stats.push({
      label: "Fees outstanding",
      value: money(overview.fees.outstandingMinor),
      sub: `${money(overview.fees.collectedMinor)} collected`,
      href: "/fees",
    });
  if (overview?.grades?.averagePct != null && isFamily)
    stats.push({ label: "Grade average", value: `${overview.grades.averagePct}%`, sub: "published results", href: "/gradebook" });
  if (can("workflow.read"))
    stats.push({ label: "Approvals", value: String(pending), sub: pending === 1 ? "awaiting review" : "awaiting review", href: "/workflows" });
  stats.push({ label: "Unread", value: String(unread), sub: "in your inbox", href: "/notifications" });
  const kpis = stats.slice(0, 4);

  // --- Quick actions: the role's real daily tasks (permission + module gated) --
  const actions: { icon: LucideIcon; label: string; href: string; hint: string; show: boolean }[] = [
    { icon: CalendarCheckIcon, label: "Take the register", href: "/attendance", hint: "Mark today's attendance", show: can("attendance.write") },
    { icon: GraduationCapIcon, label: "Record grades", href: "/gradebook", hint: "Scores & term results", show: can("grade.write") },
    { icon: ClipboardCheckIcon, label: "Review approvals", href: "/workflows", hint: pending ? `${pending} waiting on you` : "Nothing pending", show: can("workflow.review") || can("workflow.review.head") || can("workflow.review.hr") || can("workflow.review.principal") },
    { icon: CreditCardIcon, label: can("fee.manage") ? "Manage fees" : "Pay fees", href: "/fees", hint: can("fee.manage") ? "Invoices & payments" : "Invoices & receipts", show: can("fee.read") && mod("fees") },
    { icon: BookOpenIcon, label: "My classes", href: "/classes", hint: "Lessons, quizzes & forums", show: can("class.read") && mod("lms") },
    { icon: MonitorCheckIcon, label: "CBT exams", href: "/cbt", hint: can("cbt.manage") ? "Author & schedule" : "Sit your exams", show: (can("cbt.manage") || can("cbt.take")) && mod("cbt") },
    { icon: AwardIcon, label: "Scholarships", href: "/scholarships", hint: "Requests & decisions", show: can("scholarship.apply") || can("scholarship.read") },
    { icon: BriefcaseIcon, label: "HR & payroll", href: "/hr", hint: "Staff records & runs", show: can("hr.read") && mod("hr") },
    { icon: UsersIcon, label: "My children", href: "/family", hint: "Profiles & progress", show: can("family.read") },
    { icon: MessageSquareIcon, label: "Messages", href: "/messages", hint: "Write to the school", show: can("message.read") && mod("messaging") },
    { icon: FolderIcon, label: "Documents", href: "/documents", hint: "Report cards & receipts", show: can("document.read") && mod("documents") },
    { icon: Gamepad2Icon, label: "Games", href: "/games", hint: "Learn through play", show: can("game.leaderboard.read") && mod("games") },
  ].filter((a) => a.show);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="dashboard" permissions={user.permissions}>
      <div className="space-y-6">
        {/* ---- The day-ledger header: today's page of the register ---------- */}
        <PageHeader
          eyebrow={DAY_FMT.format(lagosNow())}
          title={<>{greeting()}, {firstName}.</>}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-medium text-foreground/80">{user.schoolName}</span>
              <span aria-hidden className="hidden h-3.5 w-px bg-border sm:block" />
              <span className="flex flex-wrap gap-1.5">
                {user.roles.map((r) => (
                  <span
                    key={r}
                    className="rounded-full border border-primary/25 bg-primary/8 px-2.5 py-0.5 text-xs font-medium capitalize text-primary"
                  >
                    {r.replaceAll("_", " ")}
                  </span>
                ))}
              </span>
            </span>
          }
        >
          {/* ---- Ledger KPI strip -------------------------------------------- */}
          {kpis.length > 0 && (
            <div className="flex flex-wrap">
              {kpis.map((s) => (
                <Stat key={s.label} {...s} />
              ))}
            </div>
          )}
        </PageHeader>

        {/* ---- Quick actions ------------------------------------------------ */}
        {actions.length > 0 && (
          <section aria-label="Quick actions">
            <p className="eyebrow mb-2.5">Quick actions</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {actions.slice(0, 6).map((a) => (
                <Action key={a.href} icon={a.icon} label={a.label} href={a.href} hint={a.hint} />
              ))}
            </div>
          </section>
        )}

        {/* ---- Feeds: recent activity + upcoming events --------------------- */}
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base">Recent activity</CardTitle>
              <Link href="/notifications" className="text-xs font-medium text-primary hover:underline">
                Inbox{unread > 0 ? ` (${unread})` : ""} →
              </Link>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  <BellIcon className="h-4 w-4 shrink-0" aria-hidden />
                  All caught up — receipts, absences, approvals and announcements will appear here.
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {recent.map((n) => (
                    <li key={n.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${typeDot(n.type)} ${n.readAt ? "opacity-30" : ""}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${n.readAt ? "text-muted-foreground" : "font-medium"}`}>{n.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                      </span>
                      <span className="tnum shrink-0 pt-0.5 text-xs text-muted-foreground/70">{ago(n.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base">Upcoming</CardTitle>
              <Link href="/calendar" className="text-xs font-medium text-primary hover:underline">Calendar →</Link>
            </CardHeader>
            <CardContent>
              {upcoming.length === 0 ? (
                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  <CalendarDaysIcon className="h-4 w-4 shrink-0" aria-hidden />
                  No upcoming events on the school calendar.
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {upcoming.map((e) => {
                    const d = new Date(e.startsAt);
                    return (
                      <li key={e.id} className="flex items-center gap-3">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border/70 bg-background text-center leading-none">
                          <span>
                            <span className="tnum block text-sm font-semibold">{d.getDate()}</span>
                            <span className="eyebrow block text-[0.5rem]">
                              {d.toLocaleString("en-NG", { month: "short", timeZone: "Africa/Lagos" })}
                            </span>
                          </span>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{e.title}</span>
                          <span className="block text-xs capitalize text-muted-foreground">
                            {e.audience.toLowerCase()} · {shortDate(e.startsAt)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---- Access footer (replaces the raw permission dump) ------------- */}
        <p className="text-xs text-muted-foreground">
          Your menu shows exactly what your role can use — the server re-checks every action.{" "}
          <Link href="/help" className="font-medium text-primary hover:underline">Read your role&apos;s guide →</Link>
        </p>
      </div>
    </AppShell>
  );
}
