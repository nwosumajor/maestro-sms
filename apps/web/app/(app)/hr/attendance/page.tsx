import Link from "next/link";
import type { AttendanceRegisterDto, AttendanceSummaryDto, KioskConfigDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { regionOf, todayIn } from "@/lib/format";
import { AppShell } from "@/components/shell/AppShell";
import { AttendanceAdmin, BiometricAdmin } from "@/components/hr/AttendanceAdmin";
import { DutyRoster } from "@/components/hr/DutyRoster";
import { PageHeader } from "@/components/shell/PageHeader";
import { SweepButton } from "@/components/maintenance/SweepButton";

export const dynamic = "force-dynamic";

// Staff attendance: the admin-marked daily register (Mode A) + the anti-spoofing
// TOTP clock-in kiosk (Mode B). Flags are signals for human review, never
// automatic penalties. hr.read views; hr.write marks/configures.
export default async function StaffAttendancePage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "hr.attendance.amend");
  const canShowCode = hasPermission(user.permissions, "hr.kiosk.display");

  // The SCHOOL's day, not the server's UTC one — this drives which register is
  // fetched and shown, so getting it wrong files a day of staff attendance
  // against the wrong date.
  const today = todayIn(regionOf(user).timezone);
  const [register, kiosk, summary] = await Promise.all([
    apiGet<Serialized<AttendanceRegisterDto>>(`/hr/attendance/register/${today}`),
    apiGet<Serialized<KioskConfigDto>>(`/hr/attendance/kiosk`),
    // NO year/month: the service resolves THIS MONTH in the school's timezone,
    // and its docstring says so. This passed `new Date()` from the SERVER while
    // deriving the register day from the school's clock two lines above — so
    // around a month boundary the page showed 1 February's register beside
    // January's roll-up, having defeated the correct default by supplying one.
    apiGet<Serialized<AttendanceSummaryDto>>(`/hr/attendance/summary`),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/hr" className="text-sm text-muted-foreground hover:underline">
            ← Back to HR
          </Link></>} title={<>Staff attendance</>} subtitle={<>The daily register, the clock-in kiosk, and this month’s roll-up. Off-site clock-ins are flagged
            for review — they never trigger automatic action.</>} />
        <AttendanceAdmin initialRegister={register} initialKiosk={kiosk} initialSummary={summary} canWrite={canWrite} />
        <BiometricAdmin staff={(register?.rows ?? []).map((r) => ({ userId: r.userId, userName: r.userName }))} canWrite={canWrite} />
        <DutyRoster staff={(register?.rows ?? []).map((r) => ({ userId: r.userId, userName: r.userName }))} canWrite={canWrite} />
        {canWrite && (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Close today&rsquo;s register</h2>
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <SweepButton
                path="hr/attendance/day-close/run"
                label="Close today now"
                help="Marks anyone with no clock-in as absent, and anyone on approved leave as on leave. Runs on its own each evening — this is for closing the day early."
              />
              {canShowCode && (
                <p className="text-sm text-muted-foreground">
                  Running a screen at the gate?{" "}
                  <Link href="/kiosk" className="underline">
                    Open the clock-in display
                  </Link>{" "}
                  — it shows the rotating code and nothing else.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
