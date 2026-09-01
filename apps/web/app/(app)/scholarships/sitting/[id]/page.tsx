import type { CbtSittingViewDto, Serialized } from "@sms/types";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { CbtExamRoom } from "@/components/cbt/CbtExamRoom";

export const dynamic = "force-dynamic";

/**
 * Sitting a PLATFORM SCHOLARSHIP exam.
 *
 * Deliberately not `/cbt/sitting/[id]`: that page is gated on `cbt.take` and
 * its API is gated on the PREMIUM CBT module, so a qualified candidate at a
 * STANDARD school met a 404 — measured live. This page and its routes are
 * always-on, carry the scholarship's own audience (`scholarship.apply`, which
 * students hold), and reuse the SAME exam room, so the paper behaves
 * identically whichever door the candidate came through.
 */
export default async function ScholarshipSittingPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "scholarship.apply")) redirect("/dashboard");
  const sitting = await apiGet<Serialized<CbtSittingViewDto>>(`/scholarships/sittings/${params.id}`);
  if (!sitting) notFound();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="scholarships" permissions={user.permissions}>
      <CbtExamRoom initial={sitting} basePath="scholarships" />
    </AppShell>
  );
}
