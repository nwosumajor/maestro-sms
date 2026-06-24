import * as React from "react";
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
  Gamepad2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TenantTheme } from "@sms/tokens";
import type { Permission } from "@sms/types";

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
  | "documents"
  | "assessments"
  | "workflows"
  | "admin"
  | "analytics"
  | "messages"
  | "calendar"
  | "hr"
  | "games"
  | "operator"
  | "account";

const NAV: { key: NavKey; label: string; icon: LucideIcon; href: string; perm?: Permission }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon, href: "/dashboard" },
  { key: "analytics", label: "Analytics", icon: BarChart3Icon, href: "/analytics" },
  { key: "operator", label: "Operator", icon: Building2Icon, href: "/operator", perm: "platform.operate" },
  { key: "admin", label: "Admin", icon: SettingsIcon, href: "/admin", perm: "fee.manage" },
  { key: "notifications", label: "Notifications", icon: BellIcon, href: "/notifications", perm: "notification.read" },
  { key: "messages", label: "Messages", icon: MessageSquareIcon, href: "/messages", perm: "message.read" },
  { key: "calendar", label: "Calendar", icon: CalendarIcon, href: "/calendar", perm: "event.read" },
  { key: "students", label: "Students", icon: IdCardIcon, href: "/students", perm: "student.profile.read" },
  { key: "classes", label: "Classes", icon: UsersIcon, href: "/classes", perm: "class.read" },
  { key: "timetable", label: "Timetable", icon: CalendarDaysIcon, href: "/timetable", perm: "timetable.read" },
  { key: "attendance", label: "Attendance", icon: CalendarCheckIcon, href: "/attendance", perm: "attendance.read" },
  { key: "fees", label: "Fees", icon: CreditCardIcon, href: "/fees", perm: "fee.read" },
  { key: "documents", label: "Documents", icon: FolderIcon, href: "/documents", perm: "document.read" },
  { key: "hr", label: "HR", icon: BriefcaseIcon, href: "/hr", perm: "hr.read" },
  { key: "assessments", label: "Assessments", icon: BookOpenIcon, href: "/assessments", perm: "assessment.read" },
  { key: "workflows", label: "Approvals", icon: ClipboardCheckIcon, href: "/workflows", perm: "workflow.read" },
  { key: "games", label: "Games", icon: Gamepad2Icon, href: "/games", perm: "game.leaderboard.read" },
  { key: "account", label: "Account", icon: UserIcon, href: "/account" },
];

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

function brandStyle(t?: TenantTheme): React.CSSProperties | undefined {
  if (!t) return undefined;
  return {
    ["--brand-h" as string]: String(t.h),
    ["--brand-s" as string]: `${t.s}%`,
    ["--brand-l" as string]: `${t.l}%`,
  };
}

export function AppShell({
  schoolName,
  userName,
  active,
  permissions = [],
  tenantTheme,
  children,
}: AppShellProps) {
  const items = NAV.filter((item) => !item.perm || permissions.includes(item.perm));
  return (
    <div data-tenant style={brandStyle(tenantTheme)} className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground text-sm font-bold">
            {schoolName.slice(0, 1).toUpperCase()}
          </div>
          <span className="text-sm font-semibold">{schoolName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{userName}</span>
          <div className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
            {userName.slice(0, 2).toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Left nav */}
        <nav
          aria-label="Primary"
          className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 border-r border-border bg-card p-3 md:block"
        >
          <ul className="space-y-1">
            {items.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === active;
              return (
                <li key={item.key}>
                  <a
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content */}
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[960px] px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
