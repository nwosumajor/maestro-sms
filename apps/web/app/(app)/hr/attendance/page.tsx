import Link from "next/link";
import type { AttendanceRegisterDto, AttendanceSummaryDto, KioskConfigDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AttendanceAdmin, BiometricAdmin } from "@/components/hr/AttendanceAdmin";
import { DutyRoster } from "@/components/hr/DutyRoster";

export const dynamic = "force-dynamic";

// Staff attendance: the admin-marked daily register (Mode A) + the anti-spoofing
// TOTP clock-in kiosk (Mode B). Flags are signals for human review, never
// automatic penalties. hr.read views; hr.write marks/configures.
export default async function StaffAttendancePage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "hr.write");

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const [register, kiosk, summary] = await Promise.all([
    apiGet<Serialized<AttendanceRegisterDto>>(`/hr/attendance/register/${today}`),
    apiGet<Serialized<KioskConfigDto>>(`/hr/attendance/kiosk`),
    apiGet<Serialized<AttendanceSummaryDto>>(`/hr/attendance/summary?year=${now.getFullYear()}&month=${now.getMonth() + 1}`),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/hr" className="text-sm text-muted-foreground hover:underline">
            ← Back to HR
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Staff attendance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The daily register, the clock-in kiosk, and this month’s roll-up. Off-site clock-ins are flagged
            for review — they never trigger automatic action.
          </p>
        </div>
        <AttendanceAdmin initialRegister={register} initialKiosk={kiosk} initialSummary={summary} canWrite={canWrite} />
        <BiometricAdmin staff={(register?.rows ?? []).map((r) => ({ userId: r.userId, userName: r.userName }))} canWrite={canWrite} />
        <DutyRoster staff={(register?.rows ?? []).map((r) => ({ userId: r.userId, userName: r.userName }))} canWrite={canWrite} />
      </div>
    </AppShell>
  );
}
