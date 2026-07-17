// Operator SCHOOL DIRECTORY — every onboarded school with the people behind it
// (proprietor + admin/principal contacts), onboarding date, subscription
// posture, last payment and outstanding arrears. Row click → the full profile.
// Gated platform.tenants.read (same as the registry on /operator).

import type { SchoolDirectoryPageDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { DirectoryFilterBar } from "@/components/operator/DirectoryFilterBar";
import { money, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type DirectoryPage = Serialized<SchoolDirectoryPageDto>;

function billingBadge(status: string): "secondary" | "outline" | "destructive" {
  if (status === "ACTIVE") return "secondary";
  if (status === "PAST_DUE") return "destructive";
  return "outline";
}

export default async function OperatorSchoolsPage({
  searchParams,
}: {
  searchParams: { q?: string; plan?: string; billing?: string; status?: string; sort?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  const q = searchParams.q ?? "";
  const plan = searchParams.plan ?? "";
  const billing = searchParams.billing ?? "";
  const status = searchParams.status ?? "";
  const sort = searchParams.sort ?? "";
  const pageNum = Math.max(1, Number(searchParams.page ?? "1") || 1);
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (plan) query.set("plan", plan);
  if (billing) query.set("billing", billing);
  if (status) query.set("status", status);
  if (sort) query.set("sort", sort);
  if (pageNum > 1) query.set("page", String(pageNum));

  const page = await apiGet<DirectoryPage>(`/operator/directory?${query.toString()}`);
  const rows = page?.rows ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">School directory</h1>
            <p className="text-sm text-muted-foreground">
              Every onboarded school — owners, contacts and billing at a glance. Click a school for its full profile.
            </p>
          </div>
          <Link href="/operator" className="text-sm text-primary hover:underline">← Operator console</Link>
        </div>

        <DirectoryFilterBar
          q={q}
          plan={plan}
          billing={billing}
          status={status}
          sort={sort}
          page={page?.page ?? pageNum}
          pageSize={page?.pageSize ?? 20}
          total={page?.total ?? rows.length}
        />

        {rows.length === 0 ? (
          <p className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No schools match this search/filter.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">School</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">School admin</th>
                  <th className="px-4 py-3">Principal</th>
                  <th className="px-4 py-3">Onboarded</th>
                  <th className="px-4 py-3">Plan / billing</th>
                  <th className="px-4 py-3">Last payment</th>
                  <th className="px-4 py-3 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/operator/schools/${s.id}`} className="font-medium text-primary hover:underline">
                        {s.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{s.slug}</span> · {s.students} students
                        {s.status !== "ACTIVE" && <Badge variant="destructive" className="ml-1.5">DISABLED</Badge>}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {s.ownerName ?? <span className="text-muted-foreground">—</span>}
                      {s.ownerPhone && <p className="tnum text-xs text-muted-foreground">{s.ownerPhone}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {s.admin?.name ?? <span className="text-muted-foreground">—</span>}
                      {s.admin?.phone && <p className="tnum text-xs text-muted-foreground">{s.admin.phone}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {s.principal?.name ?? <span className="text-muted-foreground">—</span>}
                      {s.principal?.phone && <p className="tnum text-xs text-muted-foreground">{s.principal.phone}</p>}
                    </td>
                    <td className="tnum px-4 py-3">{shortDate(s.onboardedAt)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{s.plan}</Badge>{" "}
                      <Badge variant={billingBadge(s.subscriptionStatus)}>{s.subscriptionStatus.replace("_", " ")}</Badge>
                      {s.currentPeriodEnd && (
                        <p className="text-xs text-muted-foreground">until {shortDate(s.currentPeriodEnd)}</p>
                      )}
                    </td>
                    <td className="tnum px-4 py-3">
                      {s.lastPaymentAt ? shortDate(s.lastPaymentAt) : <span className="text-muted-foreground">never</span>}
                    </td>
                    <td className="tnum px-4 py-3 text-right">
                      {s.outstandingMinor > 0 ? (
                        <span className="font-medium text-destructive">{money(s.outstandingMinor)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
