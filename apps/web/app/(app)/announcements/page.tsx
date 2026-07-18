import type { AnnouncementDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AnnouncementsBoard } from "@/components/announcements/AnnouncementsBoard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "announcement.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "announcement.manage");
  const announcements = (await apiGet<Serialized<AnnouncementDto>[]>("/announcements")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="announcements" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Announcements</>} subtitle={<>{canManage
              ? "Post notices to your whole school. Students and parents see them on this page."
              : "Notices from your school."}</>} />
        <AnnouncementsBoard announcements={announcements} canManage={canManage} />
      </div>
    </AppShell>
  );
}
