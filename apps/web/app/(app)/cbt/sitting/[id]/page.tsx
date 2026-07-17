import type { CbtSittingViewDto, Serialized } from "@sms/types";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { CbtExamRoom } from "@/components/cbt/CbtExamRoom";

export const dynamic = "force-dynamic";

export default async function CbtSittingPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const sitting = await apiGet<Serialized<CbtSittingViewDto>>(`/cbt/sittings/${params.id}`);
  if (!sitting) notFound();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="cbt" permissions={user.permissions}>
      <CbtExamRoom initial={sitting} />
    </AppShell>
  );
}
