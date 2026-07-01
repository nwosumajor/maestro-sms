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
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import type { TenantTheme } from "@sms/tokens";
import { MODULES, type ModuleKey, type Permission } from "@sms/types";

// App shell: persistent left nav + top bar. The brand mark + active-nav color
// come from --primary, so a tenant theme swap re-skins the whole shell with no
// component changes (design-system rule). Nav items are filtered by the caller's
// permissions so each role sees only what it can use.

type NavKey =
  | "dashboard"
  | "notifications"
  | "students"
  | "classes"
  | "timetable"
  | "attendance"
  | "fees"
  | "hostel"
  | "transport"
  | "library"
  | "billing"
  | "documents"
  | "assessments"
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
  | "hr"
  | "leave"
  | "games"
  | "ultimate"
  | "operator"
  | "operatoraudit"
  | "directory"
  | "announcements"
  | "account";

// `module` ties a nav item to a subscription module: when the school's plan
// doesn't include it, the item is hidden (and the backend 404s the routes too).
// Items with no `module` are always-on (auth/admin/notifications/account).
const NAV: {
  key: NavKey;
  label: string;
  icon: LucideIcon;
  href: string;
  perm?: Permission;
  module?: ModuleKey;
}[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon, href: "/dashboard" },
  { key: "analytics", label: "Analytics", icon: BarChart3Icon, href: "/analytics", module: MODULES.ANALYTICS },
  { key: "operator", label: "Operator", icon: Building2Icon, href: "/operator", perm: "platform.operate" },
  { key: "operatoraudit", label: "Platform audit", icon: ScrollTextIcon, href: "/operator/audit", perm: "platform.operate" },
  { key: "directory", label: "Directory", icon: SearchIcon, href: "/directory", perm: "directory.search" },
  { key: "admin", label: "Admin", icon: SettingsIcon, href: "/admin", perm: "fee.manage" },
  { key: "announcements", label: "Announcements", icon: MegaphoneIcon, href: "/announcements", perm: "announcement.read" },
  { key: "notifications", label: "Notifications", icon: BellIcon, href: "/notifications", perm: "notification.read" },
  { key: "messages", label: "Messages", icon: MessageSquareIcon, href: "/messages", perm: "message.read", module: MODULES.MESSAGING },
  { key: "calendar", label: "Calendar", icon: CalendarIcon, href: "/calendar", perm: "event.read", module: MODULES.CALENDAR },
  { key: "students", label: "Students", icon: IdCardIcon, href: "/students", perm: "student.profile.read", module: MODULES.SIS },
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
  { key: "documents", label: "Documents", icon: FolderIcon, href: "/documents", perm: "document.read", module: MODULES.DOCUMENTS },
  { key: "leave", label: "Leave", icon: CalendarCheckIcon, href: "/leave", perm: "hr.self", module: MODULES.HR },
  { key: "hr", label: "HR", icon: BriefcaseIcon, href: "/hr", perm: "hr.read", module: MODULES.HR },
  { key: "assessments", label: "Assessments", icon: BookOpenIcon, href: "/assessments", perm: "assessment.read", module: MODULES.INTEGRITY },
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
];

// The nav keys a platform owner (super_admin) sees — platform surfaces only, since
// they belong to no customer school. Everything else is a tenant-operational page.
const PLATFORM_OWNER_NAV = new Set<NavKey>([
  "dashboard",
  "operator",
  "operatoraudit",
  "directory",
  "ultimate",
  "notifications",
  "account",
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
  notifications: "overview", messages: "overview", calendar: "overview",
  classes: "teaching", timetable: "teaching", assessments: "teaching", certificates: "teaching",
  documents: "teaching", library: "teaching",
  students: "people", attendance: "people", hr: "people", leave: "people", alumni: "people",
  fees: "operations", billing: "operations", hostel: "operations", transport: "operations",
  workflows: "operations", tasks: "operations",
  discussion: "community", polls: "community", forms: "community", discipline: "community",
  games: "community", ultimate: "community",
  operator: "platform", operatoraudit: "platform", directory: "platform", admin: "platform", account: "platform",
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
  // The platform owner (super_admin) is not a member of any customer school, so the
  // tenant-operational pages (Analytics, Games, …) are noise for them. Restrict
  // their nav to the platform surfaces; the operator console is their home.
  const isPlatformOwner = permissions.includes("platform.operate");
  const items = NAV.filter(
    (item) =>
      (!isPlatformOwner || PLATFORM_OWNER_NAV.has(item.key)) &&
      (!item.perm || permissions.includes(item.perm)) &&
      (!item.module || !modules || modules.includes(item.module)),
  );
  // Apply the school's saved theme (brand colour + font). Best-effort; falls back
  // to the passed tenantTheme / platform defaults if the fetch returns nothing.
  let theme = tenantTheme;
  let fontFamily: string | null = null;
  if (!isPlatformOwner) {
    const branding = await apiGet<{ brandHue: number | null; brandSat: number | null; brandLight: number | null; fontFamily: string | null }>(
      "/schools/branding",
    ).catch(() => null);
    if (branding?.brandHue != null && branding.brandSat != null && branding.brandLight != null) {
      theme = { h: branding.brandHue, s: branding.brandSat, l: branding.brandLight };
    }
    fontFamily = branding?.fontFamily ?? null;
  }
  return (
    <div data-tenant style={brandStyle(theme, fontFamily)} className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/70 bg-card/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-card/65">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-bold shadow-xs ring-1 ring-inset ring-white/10">
            {schoolName.slice(0, 1).toUpperCase()}
          </div>
          <div className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight">{schoolName}</span>
            <span className="eyebrow hidden text-[0.6rem] sm:block">School Console</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
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

      <div className="flex">
        {/* Left nav — grouped "register sections" */}
        <nav
          aria-label="Primary"
          className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar px-3 py-4 md:block"
        >
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
                          <a
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all",
                              isActive
                                ? "bg-primary/10 font-semibold text-primary shadow-xs"
                                : "font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            {/* Active accent bar — the page tab in the register. */}
                            <span
                              aria-hidden
                              className={cn(
                                "absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
                                isActive ? "opacity-100" : "opacity-0",
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
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </nav>

        {/* Content */}
        <main className="min-w-0 flex-1 bg-brand-wash">
          <div className="mx-auto max-w-[1024px] animate-fade-up px-5 py-8 sm:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
