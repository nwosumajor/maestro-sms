import * as React from "react";
import { signOut } from "@/lib/auth";
import {
  LayoutDashboardIcon,
  UsersIcon,
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
  GraduationCapIcon,
  FileBarChartIcon,
  WalletIcon,
  ScrollTextIcon,
  CircleHelpIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { ImpersonationBanner } from "./ImpersonationBanner";
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
  | "notifications"
  | "students"
  | "family"
  | "classes"
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
  | "hr"
  | "leave"
  | "games"
  | "ultimate"
  | "operator"
  | "operatortenants"
  | "operatorscholarships"
  | "operatoraudit"
  | "directory"
  | "announcements"
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
  module?: ModuleKey;
}[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon, href: "/dashboard" },
  { key: "analytics", label: "Analytics", icon: BarChart3Icon, href: "/analytics", module: MODULES.ANALYTICS },
  { key: "operator", label: "Operator", icon: Building2Icon, href: "/operator", perm: "platform.tenants.read" },
  { key: "operatortenants", label: "Tenant registry", icon: ServerIcon, href: "/operator/tenants", perm: "platform.tenants.read" },
  { key: "operatorscholarships", label: "Scholarship admin", icon: AwardIcon, href: "/operator/scholarships", perm: "scholarship.admin" },
  { key: "operatoraudit", label: "Platform audit", icon: ScrollTextIcon, href: "/operator/audit", perm: "platform.audit.read" },
  { key: "directory", label: "Directory", icon: SearchIcon, href: "/directory", perm: "directory.search" },
  { key: "admin", label: "Admin", icon: SettingsIcon, href: "/admin", perm: "fee.manage" },
  { key: "announcements", label: "Announcements", icon: MegaphoneIcon, href: "/announcements", perm: "announcement.read" },
  { key: "notifications", label: "Notifications", icon: BellIcon, href: "/notifications", perm: "notification.read" },
  { key: "messages", label: "Messages", icon: MessageSquareIcon, href: "/messages", perm: "message.read", module: MODULES.MESSAGING },
  { key: "calendar", label: "Calendar", icon: CalendarIcon, href: "/calendar", perm: "event.read", module: MODULES.CALENDAR },
  { key: "meetings", label: "Meetings", icon: CalendarCheckIcon, href: "/meetings", anyPerm: ["meeting.host", "meeting.book"] },
  { key: "exams", label: "Exams", icon: ClipboardListIcon, href: "/exams", perm: "timetable.read" },
  { key: "students", label: "Students", icon: IdCardIcon, href: "/students", perm: "student.profile.read", module: MODULES.SIS },
  { key: "family", label: "My children", icon: UsersIcon, href: "/family", perm: "family.read", module: MODULES.SIS },
  { key: "classes", label: "Classes", icon: UsersIcon, href: "/classes", perm: "class.read", module: MODULES.LMS },
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
  { key: "scholarships", label: "Scholarships", icon: AwardIcon, href: "/scholarships", anyPerm: ["scholarship.apply", "scholarship.read"] },
  { key: "leave", label: "Leave", icon: CalendarCheckIcon, href: "/leave", perm: "hr.self", module: MODULES.HR },
  { key: "hr", label: "HR", icon: BriefcaseIcon, href: "/hr", perm: "hr.read", module: MODULES.HR },
  { key: "assessments", label: "Assessments", icon: BookOpenIcon, href: "/assessments", perm: "assessment.read", module: MODULES.INTEGRITY },
  { key: "cbt", label: "CBT exams", icon: BookOpenIcon, href: "/cbt", anyPerm: ["cbt.manage", "cbt.take"], module: MODULES.CBT },
  { key: "gradebook", label: "Grades", icon: GraduationCapIcon, href: "/gradebook", perm: "grade.read", module: MODULES.GRADEBOOK },
  { key: "workflows", label: "Approvals", icon: ClipboardCheckIcon, href: "/workflows", perm: "workflow.read", module: MODULES.WORKFLOW },
  { key: "tasks", label: "Tasks", icon: ListTodoIcon, href: "/tasks", perm: "task.participate", module: MODULES.TASK },
  { key: "polls", label: "Polls", icon: BarChartHorizontalIcon, href: "/polls", perm: "poll.vote", module: MODULES.POLL },
  { key: "discussion", label: "Discussion", icon: MessagesSquareIcon, href: "/discussion", perm: "discussion.participate", module: MODULES.DISCUSSION },
  { key: "discipline", label: "Discipline", icon: ShieldAlertIcon, href: "/discipline", perm: "discipline.file", module: MODULES.DISCIPLINE },
  { key: "forms", label: "Forms", icon: ClipboardListIcon, href: "/forms", perm: "form.respond", module: MODULES.FORM },
  { key: "alumni", label: "Alumni", icon: GraduationCapIcon, href: "/alumni", perm: "alumni.manage", module: MODULES.ALUMNI },
  { key: "reports", label: "Reports", icon: FileBarChartIcon, href: "/reports", perm: "attendance.read" },
  { key: "games", label: "Games", icon: Gamepad2Icon, href: "/games", perm: "game.leaderboard.read", module: MODULES.GAMES },
  // Cross-school "Ultimate" arena — a PLATFORM function: only the super_admin
  // (game.ultimate.admin) creates/cancels it. Direct link so the platform owner
  // reaches it without the tenant Games hub; hidden for everyone else (regular
  // staff open Ultimate from the Games hub instead). No module tag — the
  // super_admin-only permission is the gate.
  { key: "ultimate", label: "Ultimate", icon: TrophyIcon, href: "/games/ultimate", perm: "game.ultimate.admin" },
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
  "operatortenants",
  "operatorscholarships",
  "operatoraudit",
  "directory",
  "ultimate",
  "notifications",
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
  notifications: "overview", messages: "overview", calendar: "overview", meetings: "overview", exams: "overview",
  classes: "teaching", timetable: "teaching", assessments: "teaching", gradebook: "teaching",
  certificates: "teaching", documents: "teaching", library: "teaching",
  students: "people", family: "people", attendance: "people", hr: "people", leave: "people", alumni: "people",
  fees: "operations", billing: "operations", group: "operations", cbt: "teaching", hostel: "operations", transport: "operations",
  workflows: "operations", tasks: "operations", scholarships: "operations",
  discussion: "community", polls: "community", forms: "community", discipline: "community",
  games: "community", ultimate: "community",
  operator: "platform", operatortenants: "platform", operatorscholarships: "platform",
  operatoraudit: "platform", directory: "platform", admin: "platform", account: "platform",
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
      (!item.module || !modules || modules.includes(item.module)),
  );
  // Apply the school's saved branding (logo + brand colour + font). The member
  // endpoint needs no manage permission, so theme + logo reach EVERY signed-in
  // member of the school, not just admins. Best-effort; falls back to the passed
  // tenantTheme / platform defaults if the fetch returns nothing.
  let theme = tenantTheme;
  let fontFamily: string | null = null;
  let logoUrl: string | null = null;
  if (!isPlatformOwner) {
    const branding = await apiGet<Serialized<MemberBrandingDto>>("/schools/branding/me").catch(() => null);
    if (branding?.brandHue != null && branding.brandSat != null && branding.brandLight != null) {
      theme = { h: branding.brandHue, s: branding.brandSat, l: branding.brandLight };
    }
    fontFamily = branding?.fontFamily ?? null;
    logoUrl = branding?.logoUrl ?? null;
  }

  // Renewal/past-due banner — the trial and dunning state exist in billing, but a
  // school that never opens /billing would first notice as "modules vanished".
  // Surface it to billing.read holders (principal/school_admin) shell-wide; the
  // API call is cheap (cached entitlement resolution, no payments/quotes).
  let renewal: { kind: "PAST_DUE" | "ENDING" | "EXPIRED"; plan: string; daysLeft: number } | null = null;
  if (!isPlatformOwner && permissions.includes("billing.read")) {
    const sub = await apiGet<Serialized<SubscriptionDto>>("/billing/status").catch(() => null);
    if (sub?.currentPeriodEnd) {
      const daysLeft = Math.ceil((new Date(sub.currentPeriodEnd).getTime() - Date.now()) / 86_400_000);
      if (sub.status === "PAST_DUE") renewal = { kind: "PAST_DUE", plan: sub.plan, daysLeft };
      else if (sub.status === "ACTIVE" && daysLeft <= 0) renewal = { kind: "EXPIRED", plan: sub.plan, daysLeft };
      else if (sub.status === "ACTIVE" && daysLeft <= 14) renewal = { kind: "ENDING", plan: sub.plan, daysLeft };
    }
  }

  // Clickwrap banner: a billing MANAGER whose school hasn't accepted the
  // current legal-pack version (provisioned admins never saw the public form;
  // material terms changes bump the version and re-raise it).
  let legalPrompt: { version: string } | null = null;
  if (!isPlatformOwner && permissions.includes("billing.manage")) {
    const legal = await apiGet<{ currentVersion: string; accepted: boolean }>("/legal/acceptance/status").catch(
      () => null,
    );
    if (legal && !legal.accepted) legalPrompt = { version: legal.currentVersion };
  }
  return (
    // Theme is owned by the html-level ThemeScript + the topbar ThemeToggle
    // (defaulting to the graphite dark console). Public pages pin themselves
    // light via .force-light, so the toggle only ever restyles the app.
    <div data-tenant style={brandStyle(theme, fontFamily)} className="min-h-screen bg-background text-foreground">
      <SessionIdleGuard />
      <CredentialPromptHost />
      {impersonating && <ImpersonationBanner userName={userName} schoolName={schoolName} />}
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
  );
}
