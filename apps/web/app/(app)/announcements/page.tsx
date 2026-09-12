import type { AnnouncementPageDto, AnnouncementDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AnnouncementsBoard } from "@/components/announcements/AnnouncementsBoard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

const EMPTY_BOARD = { items: [], total: 0, shown: 0, page: 1, pageSize: 100 };

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; page?: string }>;
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "announcement.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "announcement.manage");
  // The board's controls ride the URL, so a found notice has a link. Both
  // narrow in SQL — searching the fetched page in the browser could only ever
  // see the newest 100.
  const sp = (await searchParams) ?? {};
  const q = (sp.q ?? "").trim();
  const page = Number(sp.page) > 0 ? Number(sp.page) : 1;
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (page > 1) query.set("page", String(page));
  const qs = query.toString() ? `?${query}` : "";
  const board =
    (await apiGet<Serialized<AnnouncementPageDto>>(`/announcements${qs}`)) ?? EMPTY_BOARD;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="announcements" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Announcements</>} subtitle={<>{canManage
              ? "Post notices to your whole school. Students and parents see them on this page."
              : "Notices from your school."}</>} />
        <AnnouncementsBoard board={board} query={q} canManage={canManage} />
      </div>
    </AppShell>
  );
}
