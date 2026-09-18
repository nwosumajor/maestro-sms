import type { LmsLiveSessionPageDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveClassTable } from "@/components/lms/LiveClassTable";

export const dynamic = "force-dynamic";

/**
 * Live classes, across every course the reader can see.
 *
 * The per-class panel is still the right view from inside a class. This page
 * answers a different question — "what is on, and what can I go back and watch"
 * — which no screen could ask before, because live sessions existed only as a
 * panel on one class at a time.
 *
 * THE FILTERS RUN ON THE SERVER. A search that narrows the fetched page only
 * ever sees the rows that survived the cap, which is how a reader comes to
 * believe a term holds three recordings when it holds forty.
 */
export default async function LiveClassesPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; from?: string; to?: string; recorded?: string; page?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "lms.content.read")) redirect("/dashboard");

  const query = new URLSearchParams();
  if (sp.q) query.set("q", sp.q);
  if (sp.from) query.set("from", sp.from);
  if (sp.to) query.set("to", sp.to);
  if (sp.recorded === "1") query.set("recorded", "1");
  if (sp.page) query.set("page", sp.page);
  const qs = query.toString();

  const page = await apiGet<Serialized<LmsLiveSessionPageDto>>(`/live${qs ? `?${qs}` : ""}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="live-classes" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Live classes</>}
          subtitle={
            <>
              Every live class for the courses you can see — join one that is on now, or play back a
              recorded lesson. Recordings play here and are not offered as downloads.
            </>
          }
        />
        <LiveClassTable
          initial={page ?? { rows: [], total: 0, page: 1, pageSize: 25 }}
          filters={{ q: sp.q ?? "", from: sp.from ?? "", to: sp.to ?? "", recorded: sp.recorded === "1" }}
          canManage={hasPermission(user.permissions, "lms.content.write")}
        />
      </div>
    </AppShell>
  );
}
