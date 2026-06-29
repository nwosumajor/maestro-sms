import type { AnnouncementDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AnnouncementsBoard } from "@/components/announcements/AnnouncementsBoard";

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
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Announcements</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Post notices to your whole school. Students and parents see them on this page."
              : "Notices from your school."}
          </p>
        </div>
        <AnnouncementsBoard announcements={announcements} canManage={canManage} />
      </div>
    </AppShell>
  );
}
