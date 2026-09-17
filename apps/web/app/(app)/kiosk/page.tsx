import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { KioskDisplay } from "@/components/hr/KioskDisplay";

export const dynamic = "force-dynamic";

/**
 * The gate display, and ONLY the gate display.
 *
 * The rotating code used to live on /hr/attendance, so the screen standing in a
 * corridor all day had to be signed in as somebody with `hr.read` — and it then
 * rendered every member of staff's attendance and the month's roll-up beside the
 * six digits it was there to show. Anyone walking past read the lot.
 *
 * This page renders the code and nothing else, behind `hr.kiosk.display`: the
 * narrowest permission in the module, which opens this page and one number. It
 * also deliberately drops the AppShell — no nav, no search, no way to click
 * through to anything — because the device running it is unattended.
 */
export default async function KioskPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.kiosk.display")) redirect("/dashboard");
  return <KioskDisplay schoolName={user.schoolName ?? "School"} />;
}
