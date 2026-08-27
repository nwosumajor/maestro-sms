import * as React from "react";
import { signOut } from "@/lib/auth";
import {
  LayoutDashboardIcon,
  UsersIcon,
  BookMarkedIcon,
  BookOpenIcon,
  ClipboardCheckIcon,
  BellIcon,
  CalendarDaysIcon,
  CalendarCheckIcon,
  CreditCardIcon,
  FolderIcon,
  IdCardIcon,
  SettingsIcon,
  UserIcon,
  BarChart3Icon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  InboxIcon,
  CalendarIcon,
  BriefcaseIcon,
  Building2Icon,
  ServerIcon,
  SearchIcon,
  MegaphoneIcon,
  Gamepad2Icon,
  TrophyIcon,
  BedIcon,
  BusIcon,
  LibraryIcon,
  ListTodoIcon,
  BarChartHorizontalIcon,
  MessagesSquareIcon,
  ShieldAlertIcon,
  AwardIcon,
  ClipboardListIcon,
  ScanLineIcon,
  GraduationCapIcon,
  FileBarChartIcon,
  WalletIcon,
  ScrollTextIcon,
  CircleHelpIcon,
  TriangleAlertIcon,
  TagIcon,
  NetworkIcon,
  type LucideIcon,
  Clock as ClockIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { REPORT_CENTER_PERMISSIONS } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { regionOf } from "@/lib/format";
import { RegionProvider } from "./RegionProvider";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { ElevationNotice } from "./ElevationNotice";
import { SessionIdleGuard } from "./SessionIdleGuard";
import { CredentialPromptHost } from "@/components/security/CredentialPrompt";
import { apiGet } from "@/lib/api";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { GlobalSearch } from "@/components/shell/GlobalSearch";
import { SidebarScroll } from "@/components/shell/SidebarScroll";
import { LegalAcceptBanner } from "@/components/legal/LegalAcceptBanner";
import type { TenantTheme } from "@sms/tokens";
import {
  MODULES,
  type MemberBrandingDto,
  type ModuleKey,
  type Permission,
  type Serialized,
  type SubscriptionDto,
} from "@sms/types";

// App shell: persistent left nav + top bar. The brand mark + active-nav color
// come from --primary, so a tenant theme swap re-skins the whole shell with no
// component changes (design-system rule). Nav items are filtered by the caller's
// permissions so each role sees only what it can use.

type NavKey =
  | "dashboard"
  | "runbooks"
  | "notifications"
  | "students"
  | "family"
  | "classes"
  | "learning"
  | "timetable"
  | "attendance"
  | "fees"
  | "hostel"
  | "transport"
  | "library"
  | "billing"
  | "group"
  | "cbt"
  | "documents"
  | "scholarships"
  | "assessments"
  | "gradebook"
  | "workflows"
  | "tasks"
  | "polls"
  | "discussion"
  | "discipline"
  | "certificates"
  | "forms"
  | "alumni"
  | "reports"
  | "admin"
  | "analytics"
  | "messages"
  | "calendar"
  | "meetings"
  | "exams"
  | "scan"
  | "hr"
  | "leave"
  | "games"
  | "ultimate"
  | "operator"
  | "operatorattention"
  | "operatorpricing"
  | "operatorgroups"
  | "operatortenants"
  | "operatorjobs"
  | "operatorscholarships"
  | "operatoraudit"
  | "directory"
  | "announcements"
  | "feedback"
  | "operatorfeedback"
  | "account"
  | "help";

// `module` ties a nav item to a subscription module: when the school's plan
// doesn't include it, the item is hidden (and the backend 404s the routes too).
// Items with no `module` are always-on (auth/admin/notifications/account).
const NAV: {
  key: NavKey;
  label: string;
  icon: LucideIcon;
  href: string;
  perm?: Permission;
  /** Visible if the caller holds ANY of these (for items spanning roles). */
  anyPerm?: Permission[];
  /** Hidden when the caller holds `perm` and lacks `unless` — for an entry that a
   *  better-framed one replaces, but only for that audience. */
  hideIf?: { perm: Permission; unless: Permission };
  module?: ModuleKey;
}[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon, href: "/dashboard" },
  // `fee.read` is exactly the set of roles the analytics view actually serves:
  // school-wide staff (school_admin/principal/accountant/board/junior_admin) get
  // the school aggregate, parents/students get their family view. Roles WITHOUT
  // it (teacher, HR, warden, driver, librarian) would only ever see an empty
  // "family" scope, so the link is hidden from them rather than showing zeros.
  { key: "analytics", label: "Analytics", icon: BarChart3Icon, href: "/analytics", perm: "fee.read", module: MODULES.ANALYTICS },
  { key: "operator", label: "Operator", icon: Building2Icon, href: "/operator", perm: "platform.tenants.read" },
  { key: "operatorattention", label: "Needs a decision", icon: TriangleAlertIcon, href: "/operator/attention", perm: "platform.tenants.read" },
  { key: "operatorpricing", label: "Pricing & growth", icon: TagIcon, href: "/operator/pricing", perm: "platform.pricing.manage" },
  { key: "operatorgroups", label: "School groups", icon: NetworkIcon, href: "/operator/groups", perm: "platform.subscription.manage" },
  { key: "operatortenants", label: "Tenant registry", icon: ServerIcon, href: "/operator/tenants", perm: "platform.tenants.read" },
  { key: "operatorjobs", label: "Background jobs", icon: ClockIcon, href: "/operator/jobs", perm: "platform.tenants.read" },
  { key: "operatorscholarships", label: "Scholarship admin", icon: AwardIcon, href: "/operator/scholarships", perm: "scholarship.admin" },
  { key: "operatoraudit", label: "Platform audit", icon: ScrollTextIcon, href: "/operator/audit", perm: "platform.audit.read" },
  // The operations documents. Sits with the platform group because that is who
  // reads them: the incident playbook is a map of where the load-bearing parts
  // are, and the school-facing manual is here so the owner can open the exact
  // page a principal is asking about.
  { key: "runbooks", label: "Runbooks", icon: BookMarkedIcon, href: "/runbooks", perm: "platform.tenants.read" },
  { key: "directory", label: "Directory", icon: SearchIcon, href: "/directory", perm: "directory.search" },
  { key: "admin", label: "Admin", icon: SettingsIcon, href: "/admin", perm: "fee.manage" },
  { key: "announcements", label: "Announcements", icon: MegaphoneIcon, href: "/announcements", perm: "announcement.read" },
  { key: "notifications", label: "Notifications", icon: BellIcon, href: "/notifications", perm: "notification.read" },
  { key: "messages", label: "Messages", icon: MessageSquareIcon, href: "/messages", perm: "message.read", module: MODULES.MESSAGING },
  { key: "calendar", label: "Calendar", icon: CalendarIcon, href: "/calendar", perm: "event.read", module: MODULES.CALENDAR },
  { key: "meetings", label: "Meetings", icon: CalendarCheckIcon, href: "/meetings", anyPerm: ["meeting.host", "meeting.book"] },
  { key: "exams", label: "Exams", icon: ClipboardListIcon, href: "/exams", perm: "timetable.read" },
  { key: "scan", label: "Scan ID", icon: ScanLineIcon, href: "/scan", perm: "member.scan" },
  // A guardian was offered BOTH "Students" and "My children", and for them the
  // two lead to the same one child — the first under a label that reads like the
  // school's whole roster. "My children" is the honest framing, and it now links
  // through to each child's record, so nothing is lost by hiding the other door.
  // `unless: enrollment.read` keeps it for everyone who genuinely browses a
  // roster — including a TEACHER who is also a parent at the school, which is
  // common — and a STUDENT never holds family.read, so their own record stays
  // reachable here (it is their only route to it).
  { key: "students", label: "Students", icon: IdCardIcon, href: "/students", perm: "student.profile.read", hideIf: { perm: "family.read", unless: "enrollment.read" }, module: MODULES.SIS },
  { key: "family", label: "My children", icon: UsersIcon, href: "/family", perm: "family.read", module: MODULES.SIS },
  { key: "classes", label: "Classes", icon: UsersIcon, href: "/classes", perm: "class.read", module: MODULES.LMS },
  // Gated on lms.quiz.attempt, which ONLY students hold: this is a personal to-do
  // list, and a teacher opening it would get an empty page (they are not enrolled).
  { key: "learning", label: "My learning", icon: BookOpenIcon, href: "/learning", perm: "lms.quiz.attempt", module: MODULES.LMS },
  { key: "timetable", label: "Timetable", icon: CalendarDaysIcon, href: "/timetable", perm: "timetable.read", module: MODULES.TIMETABLE },
  { key: "certificates", label: "Certificates", icon: AwardIcon, href: "/certificates", perm: "certificate.issue", module: MODULES.CERTIFICATE },
  { key: "attendance", label: "Attendance", icon: CalendarCheckIcon, href: "/attendance", perm: "attendance.read", module: MODULES.ATTENDANCE },
  { key: "fees", label: "Fees", icon: CreditCardIcon, href: "/fees", perm: "fee.read", module: MODULES.FEES },
  { key: "hostel", label: "Hostel", icon: BedIcon, href: "/hostel", perm: "hostel.read", module: MODULES.HOSTEL },
  { key: "transport", label: "Transport", icon: BusIcon, href: "/transport", perm: "transport.read", module: MODULES.TRANSPORT },
  { key: "library", label: "Library", icon: LibraryIcon, href: "/library", perm: "library.read", module: MODULES.LIBRARY },
  // Billing is the platform subscription itself — ALWAYS-ON (no module tag).
  { key: "billing", label: "Billing", icon: WalletIcon, href: "/billing", perm: "billing.read" },
  // Group console: paid add-on for multi-school proprietors. Gated only by the
  // MODULE (directorship is checked server-side, 404 for non-directors); shown
  // to billing.read staff so the proprietor's account sees it.
  { key: "group", label: "Group console", icon: BarChart3Icon, href: "/group", perm: "billing.read", module: MODULES.GROUP },
  { key: "documents", label: "Documents", icon: FolderIcon, href: "/documents", perm: "document.read", module: MODULES.DOCUMENTS },
  { key: "scholarships", label: "Scholarships", icon: AwardIcon, href: "/scholarships", anyPerm: ["scholarship.apply", "scholarship.read", "workflow.review.principal"] },
  { key: "leave", label: "Leave", icon: CalendarCheckIcon, href: "/leave", perm: "hr.self", module: MODULES.HR },
  { key: "hr", label: "HR", icon: BriefcaseIcon, href: "/hr", perm: "hr.read", module: MODULES.HR },
  { key: "assessments", label: "Assessments", icon: BookOpenIcon, href: "/assessments", perm: "assessment.read", module: MODULES.INTEGRITY },
  { key: "cbt", label: "CBT exams", icon: BookOpenIcon, href: "/cbt", anyPerm: ["cbt.manage", "cbt.take", "cbt.review"], module: MODULES.CBT },
  { key: "gradebook", label: "Grades", icon: GraduationCapIcon, href: "/gradebook", perm: "grade.read", module: MODULES.GRADEBOOK },
  // Approvals is now the UNIFIED inbox: the workflow engine's own requests PLUS
  // pending decisions aggregated from other modules (fees, HR, payroll,
  // security, admissions, privacy). So it is visible to anyone who can approve
  // ANYTHING, not just workflow.read holders — otherwise an accountant holding
  // only fee.approve would never see the page listing their own queue.
  {
    key: "workflows",
    label: "Approvals",
    icon: ClipboardCheckIcon,
    href: "/workflows",
    anyPerm: [
      "workflow.read",
      "fee.approve",
      "hr.salary.approve",
      "hr.payroll.run",
      "security.elevation.approve",
      "admission.review",
      "privacy.erasure.review",
    ],
    // NO `module` GATE, deliberately, and the comment above is why: this entry
    // exists so anyone holding ANY approving permission can reach their queue.
    // Gating it on MODULES.WORKFLOW (a PREMIUM add) hid it from every STANDARD
    // school — which can still RAISE five maker-checker requests — so the page
    // that lists them was unreachable and the requests were undecidable. The
    // AUTHORING routes behind it stay module-gated in the API.
  },
  { key: "tasks", label: "Tasks", icon: ListTodoIcon, href: "/tasks", perm: "task.participate", module: MODULES.TASK },
  { key: "polls", label: "Polls", icon: BarChartHorizontalIcon, href: "/polls", perm: "poll.vote", module: MODULES.POLL },
  { key: "discussion", label: "Discussion", icon: MessagesSquareIcon, href: "/discussion", perm: "discussion.participate", module: MODULES.DISCUSSION },
  { key: "discipline", label: "Discipline", icon: ShieldAlertIcon, href: "/discipline", perm: "discipline.file", module: MODULES.DISCIPLINE },
  { key: "forms", label: "Forms", icon: ClipboardListIcon, href: "/forms", perm: "form.respond", module: MODULES.FORM },
  { key: "alumni", label: "Alumni", icon: GraduationCapIcon, href: "/alumni", perm: "alumni.manage", module: MODULES.ALUMNI },
  // The Report Center is a STAFF hub. Gated on attendance.read it opened for
  // every parent, student, teacher, warden and driver in the school — for the
  // family readers it held one card duplicating their own Analytics nav entry,
  // and for the rest it linked to a page the nav hides from them because it
  // would show them zeros. These are exactly the reports the page can list, so
  // the entry now appears only when there is a report behind it; /reports
  // redirects anyone who reaches it by URL with nothing to show.
  {
    key: "reports",
    label: "Reports",
    icon: FileBarChartIcon,
    href: "/reports",
    anyPerm: REPORT_CENTER_PERMISSIONS,
  },
  { key: "games", label: "Games", icon: Gamepad2Icon, href: "/games", perm: "game.leaderboard.read", module: MODULES.GAMES },
  // Cross-school "Ultimate" arena — a PLATFORM function: only the super_admin
  // (game.ultimate.admin) creates/cancels it. Direct link so the platform owner
  // reaches it without the tenant Games hub; hidden for everyone else (regular
  // staff open Ultimate from the Games hub instead). No module tag — the
  // super_admin-only permission is the gate.
  { key: "ultimate", label: "Ultimate", icon: TrophyIcon, href: "/games/ultimate", perm: "game.ultimate.admin" },
  // Platform feedback — visible to EVERY signed-in role (no perm): any user can
  // send the platform owner a complaint or feature suggestion.
  { key: "feedback", label: "Send feedback", icon: MessageSquarePlusIcon, href: "/feedback" },
  // The platform owner's cross-tenant feedback inbox.
  { key: "operatorfeedback", label: "Feedback inbox", icon: InboxIcon, href: "/operator/feedback", perm: "platform.feedback.review" },
  { key: "account", label: "Account", icon: UserIcon, href: "/account" },
  // The application manual — visible to EVERY signed-in role (content inside is
  // role-aware), so a brand-new user can always find their footing.
  { key: "help", label: "Help", icon: CircleHelpIcon, href: "/help" },
];

// The nav keys a platform owner (super_admin) sees — platform surfaces only, since
// they belong to no customer school. Everything else is a tenant-operational page.
const PLATFORM_OWNER_NAV = new Set<NavKey>([
  "dashboard",
  "operator",
  "operatorattention",
  "operatorpricing",
  "operatorgroups",
  "operatortenants",
  "runbooks",
  // Background jobs. Omitted when the page was added, so the one role that runs
  // the platform's sweeps was the one role the link was hidden from — the page
  // and its permission were right, only this allow-list was not.
  "operatorjobs",
  "operatorscholarships",
  "operatoraudit",
  "directory",
  "ultimate",
  "notifications",
  // NOTE: "feedback" (Send feedback) is deliberately ABSENT. The platform team IS
  // the recipient — offering them a form to send feedback to themselves is noise.
  // They get the INBOX instead, and reply inside each thread.
  "operatorfeedback",
  "account",
  "help",
]);

// The 30+ modules are grouped into labelled sections — the "register sections"
// device: a flat list of everything is overwhelming, so the rail reads like the
// tabbed dividers of a school ledger. Order here is the order they render.
const NAV_GROUPS: { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "teaching", label: "Teaching & Learning" },
  { key: "people", label: "People & Records" },
  { key: "operations", label: "Operations" },
  { key: "community", label: "Community" },
  { key: "platform", label: "Platform & Settings" },
];

const NAV_GROUP: Record<NavKey, string> = {
  dashboard: "overview", analytics: "overview", reports: "overview", announcements: "overview",
  notifications: "overview", messages: "overview", calendar: "overview", meetings: "overview", exams: "overview", scan: "overview",
  classes: "teaching", learning: "teaching", timetable: "teaching", assessments: "teaching", gradebook: "teaching",
  certificates: "teaching", documents: "teaching", library: "teaching",
  students: "people", family: "people", attendance: "people", hr: "people", leave: "people", alumni: "people",
  fees: "operations", billing: "operations", group: "operations", cbt: "teaching", hostel: "operations", transport: "operations",
  workflows: "operations", tasks: "operations", scholarships: "operations",
  discussion: "community", polls: "community", forms: "community", discipline: "community",
  games: "community", ultimate: "community",
  operator: "platform", operatorattention: "platform", operatorpricing: "platform", operatorgroups: "platform", operatortenants: "platform", operatorjobs: "platform", operatorscholarships: "platform",
  operatoraudit: "platform", runbooks: "platform", directory: "platform", admin: "platform", account: "platform",
  feedback: "platform", operatorfeedback: "platform",
  help: "platform",
};

export interface AppShellProps {
  schoolName: string;
  /** Display name for the signed-in user (top-right). */
  userName: string;
  /** Which nav item is active. */
  active?: NavKey;
  /** The caller's permissions — nav items are filtered to what they can use. */
  permissions?: string[];
  /** Optional per-tenant brand override (only the brand hue moves). */
  tenantTheme?: TenantTheme;
  children: React.ReactNode;
}

function brandStyle(t?: TenantTheme, fontFamily?: string | null): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  if (t) {
    (style as Record<string, string>)["--brand-h"] = String(t.h);
    (style as Record<string, string>)["--brand-s"] = `${t.s}%`;
    (style as Record<string, string>)["--brand-l"] = `${t.l}%`;
  }
  if (fontFamily) style.fontFamily = fontFamily;
  return Object.keys(style).length ? style : undefined;
}

export async function AppShell({
  schoolName,
  userName,
  active,
  permissions = [],
  tenantTheme,
  children,
}: AppShellProps) {
  // Nav is filtered by BOTH permission and subscription module. Modules come from
  // the session (set at login); if absent (older session) we don't module-gate.
  const session = await auth();
  const modules = session?.user?.modules ?? null;
  // Impersonation: the shell is the target's, so this banner is the ONLY thing
  // distinguishing "you are the owner" from "you are them". Read from the session
  // rather than a prop so no caller can render an impersonated shell without it.
  const impersonating = Boolean(session?.user?.impersonatedBy);
  // Anything this session can do by an ACTIVE elevation grant rather than by a
  // role. Read from the session for the same reason as impersonation: no caller
  // should be able to render a shell that hides borrowed authority.
  const elevated = session?.user?.elevated ?? [];
  // The platform owner (super_admin) is not a member of any customer school, so the
  // tenant-operational pages (Analytics, Games, …) are noise for them. Restrict
  // their nav to the platform surfaces; the operator console is their home.
  // Platform PEOPLE (owner or delegated staff): the operator console is their home,
  // so tenant-operational nav is noise for both. Keyed on the console-entry
  // permission rather than owner identity, so manager_admin gets the same shell.
  const isPlatformOwner = permissions.includes("platform.tenants.read");
  const items = NAV.filter(
    (item) =>
      (!isPlatformOwner || PLATFORM_OWNER_NAV.has(item.key)) &&
      (!item.perm || permissions.includes(item.perm)) &&
      (!item.anyPerm || item.anyPerm.some((pp) => permissions.includes(pp))) &&
      (!item.hideIf ||
        !permissions.includes(item.hideIf.perm) ||
        permissions.includes(item.hideIf.unless)) &&
      (!item.module || !modules || modules.includes(item.module)),
  );
  // Apply the school's saved branding (logo + brand colour + font). The member
  // endpoint needs no manage permission, so theme + logo reach EVERY signed-in
  // member of the school, not just admins. Best-effort; falls back to the passed
  // tenantTheme / platform defaults if the fetch returns nothing.
  //
  // PERF: these three shell lookups (branding, renewal banner, legal clickwrap)
  // are INDEPENDENT and run on EVERY page render. Awaiting them in sequence
  // added up to three serial API round-trips to every navigation — worst for
  // principals/school_admins, who hold billing.read AND billing.manage and so
  // triggered all three. Fetched together, the shell costs one round-trip's
  // latency instead of three. Each still degrades to null on failure.
  const needsRenewal = !isPlatformOwner && permissions.includes("billing.read");
  const needsLegal = !isPlatformOwner && permissions.includes("billing.manage");
  const [branding, sub, legal] = await Promise.all([
    isPlatformOwner
      ? Promise.resolve(null)
      : apiGet<Serialized<MemberBrandingDto>>("/schools/branding/me").catch(() => null),
    needsRenewal ? apiGet<Serialized<SubscriptionDto>>("/billing/status").catch(() => null) : Promise.resolve(null),
    needsLegal
      ? apiGet<{ currentVersion: string; accepted: boolean }>("/legal/acceptance/status").catch(() => null)
      : Promise.resolve(null),
  ]);

  let theme = tenantTheme;
  let fontFamily: string | null = null;
  let logoUrl: string | null = null;
  if (branding?.brandHue != null && branding.brandSat != null && branding.brandLight != null) {
    theme = { h: branding.brandHue, s: branding.brandSat, l: branding.brandLight };
  }
  fontFamily = branding?.fontFamily ?? null;
  logoUrl = branding?.logoUrl ?? null;

  // Renewal/past-due banner — a school that never opens /billing would first
  // notice a lapse as "modules vanished".
  let renewal: { kind: "PAST_DUE" | "ENDING" | "EXPIRED"; plan: string; daysLeft: number } | null = null;
  if (sub?.currentPeriodEnd) {
    const daysLeft = Math.ceil((new Date(sub.currentPeriodEnd).getTime() - Date.now()) / 86_400_000);
    if (sub.status === "PAST_DUE") renewal = { kind: "PAST_DUE", plan: sub.plan, daysLeft };
    else if (sub.status === "ACTIVE" && daysLeft <= 0) renewal = { kind: "EXPIRED", plan: sub.plan, daysLeft };
    else if (sub.status === "ACTIVE" && daysLeft <= 14) renewal = { kind: "ENDING", plan: sub.plan, daysLeft };
  }

  // Clickwrap banner: a billing MANAGER whose school hasn't accepted the
  // current legal-pack version.
  let legalPrompt: { version: string } | null = null;
  if (legal && !legal.accepted) legalPrompt = { version: legal.currentVersion };
  // The school's locale/timezone/currency, published to every client island below.
  // Taken from the SAME session the server render used, so the two format
  // identically — a divergence here is a hydration mismatch, which a user sees as
  // a blank page rather than a wrong date.
  const region = regionOf(session?.user);

  return (
    // Theme is owned by the html-level ThemeScript + the topbar ThemeToggle
    // (defaulting to the graphite dark console). Public pages pin themselves
    // light via .force-light, so the toggle only ever restyles the app.
    <RegionProvider region={region}>
    <div data-tenant style={brandStyle(theme, fontFamily)} className="min-h-screen bg-background text-foreground">
      <SessionIdleGuard />
      <CredentialPromptHost />
      {impersonating && <ImpersonationBanner userName={userName} schoolName={schoolName} />}
      {elevated.length > 0 && (
        <ElevationNotice permissions={elevated} canReview={permissions.includes("security.elevation.request")} />
      )}
      {/* Top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/70 bg-card/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-card/65">
        <div className="flex items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- tenant logo via presigned storage URL
            <img
              src={logoUrl}
              alt={`${schoolName} logo`}
              className="h-8 w-8 rounded-lg border border-border/60 bg-white object-contain"
            />
          ) : (
            // Platform default mark (MajorGBN) until the school uploads its own.
            // eslint-disable-next-line @next/next/no-img-element -- static platform asset
            <img src="/images/platform-mark.png" alt="MajorGBN" className="h-8 w-8 object-contain" />
          )}
          <div className="leading-tight">
            <span className="block font-display text-[0.95rem] font-semibold tracking-tight">{schoolName}</span>
            <span className="eyebrow hidden text-[0.6rem] sm:block">
              {isPlatformOwner ? "Super Admin Console" : "School Console"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <GlobalSearch />
          {/* Light / Auto / Dark — the console defaults to the graphite dark theme. */}
          <ThemeToggle />
          <div className="hidden items-center gap-2.5 rounded-full border border-border/70 bg-background/60 py-1 pl-2.5 pr-1 sm:flex">
            <span className="text-sm font-medium text-foreground/80">{userName}</span>
            <div className="grid h-7 w-7 place-items-center rounded-full bg-primary/12 text-[0.7rem] font-semibold text-primary">
              {userName.slice(0, 2).toUpperCase()}
            </div>
          </div>
          {/* Sign out — available to every authenticated user (no permission gate). */}
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              aria-label="Sign out"
              className="rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* Clickwrap: current legal-pack version not yet accepted by this school. */}
      {legalPrompt && <LegalAcceptBanner version={legalPrompt.version} />}

      {/* Renewal / past-due banner — the conversion nudge for billing.read staff. */}
      {renewal && (
        <Link
          href="/billing"
          className={cn(
            "block px-4 py-2 text-center text-sm font-medium transition-colors",
            renewal.kind === "ENDING"
              ? "bg-severity-low-bg text-severity-low-fg hover:brightness-[0.98]"
              : "bg-severity-high-bg text-severity-high-fg hover:brightness-[0.98]",
          )}
        >
          {renewal.kind === "PAST_DUE" &&
            `Payment overdue — your ${renewal.plan} plan drops to the Standard floor after the grace period. Renew now →`}
          {renewal.kind === "EXPIRED" &&
            `Your ${renewal.plan} plan period has ended — renew now to keep all modules →`}
          {renewal.kind === "ENDING" &&
            `Your ${renewal.plan} plan ends in ${renewal.daysLeft} day${renewal.daysLeft === 1 ? "" : "s"} — renew to keep all modules →`}
        </Link>
      )}

      <div className="flex">
        {/* Left nav — grouped "register sections" */}
        <SidebarScroll className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar px-3 py-4 md:block">
          <div className="space-y-5">
            {NAV_GROUPS.map((group) => {
              const groupItems = items.filter((it) => NAV_GROUP[it.key] === group.key);
              if (groupItems.length === 0) return null;
              return (
                <div key={group.key}>
                  <p className="eyebrow px-3 pb-1.5">{group.label}</p>
                  <ul className="space-y-0.5">
                    {groupItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = item.key === active;
                      return (
                        <li key={item.key}>
                          <Link
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all",
                              isActive
                                ? "bg-primary/10 font-semibold text-primary shadow-xs"
                                : "font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            {/* Active accent — the exercise book's red MARGIN RULE.
                                Decorative signature (not destructive semantics). */}
                            <span
                              aria-hidden
                              className={cn(
                                "absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-r-full bg-rule transition-opacity",
                                isActive ? "opacity-90" : "opacity-0",
                              )}
                            />
                            <Icon
                              className={cn(
                                "h-[1.05rem] w-[1.05rem] shrink-0 transition-colors",
                                isActive ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground",
                              )}
                              aria-hidden
                            />
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </SidebarScroll>

        {/* Content */}
        <main className="min-w-0 flex-1 bg-brand-wash">
          <div className="mx-auto max-w-[1024px] animate-fade-up px-5 py-8 sm:px-8">{children}</div>
        </main>
      </div>
    </div>
    </RegionProvider>
  );
}
