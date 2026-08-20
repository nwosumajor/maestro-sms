"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LeaveRequestDto, LeaveTypeDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Type = Serialized<LeaveTypeDto>;
type Request = Serialized<LeaveRequestDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "secondary", APPROVED: "default", REJECTED: "destructive", CANCELLED: "outline",
};

export function LeaveAdmin({
  types,
  requests,
  coverage,
  total,
  page,
  pageSize,
  filters,
}: {
  types: Type[];
  requests: Request[];
  coverage: Request[];
  total: number;
  page: number;
  pageSize: number;
  filters: { status: string; q: string; from: string; to: string };
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [days, setDays] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const addType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !days) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/leave/types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, daysPerYear: parseInt(days, 10) }),
    });
    setBusy(false);
    if (res.ok) { setName(""); setDays(""); router.refresh(); }
    else setMsg(await readApiError(res));
  };

  /** Keep the filters when paging — losing them on page 2 makes the register
   *  unsearchable again the moment a search matches more than one page. */
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.status) params.set("status", filters.status);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (n > 1) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `/hr?${qs}` : "/hr";
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Leave administration</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={addType} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="lt-name">New leave type</Label><Input id="lt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Maternity" /></div>
          <div className="space-y-1.5"><Label htmlFor="lt-days">Days/year</Label><Input id="lt-days" type="number" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></div>
          <Button type="submit" disabled={busy}>Add type</Button>
          <span className="text-sm text-muted-foreground">{types.map((t) => `${t.name} (${t.daysPerYear}d)`).join(" · ")}</span>
          {msg && <span className="text-sm text-destructive">{msg}</span>}
        </form>

        <div>
          <p className="mb-2 text-sm font-medium">Leave register</p>
          {/* "Was she on approved leave that week" is asked about last year as
              often as this one, and the register used to stop at the 500 most
              recent — 300 of 800 requests unreachable by any means. Every
              control here narrows the query in the database. */}
          <form method="GET" className="mb-3 flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="lv-q" className="text-xs">Staff member</Label>
              <Input id="lv-q" name="q" defaultValue={filters.q} placeholder="Name" className="w-44" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lv-status" className="text-xs">Status</Label>
              <select id="lv-status" name="status" defaultValue={filters.status}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Any</option>
                {["PENDING", "APPROVED", "REJECTED", "CANCELLED"].map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lv-from" className="text-xs">Off on or after</Label>
              <Input id="lv-from" name="from" type="date" defaultValue={filters.from} className="w-40" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lv-to" className="text-xs">Off on or before</Label>
              <Input id="lv-to" name="to" type="date" defaultValue={filters.to} className="w-40" />
            </div>
            <Button type="submit" size="sm">Filter</Button>
            {(filters.q || filters.status || filters.from || filters.to) && (
              <a href="/hr" className="text-sm underline underline-offset-2">Clear</a>
            )}
          </form>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filters.q || filters.status || filters.from || filters.to
                ? "No leave matches those filters."
                : "No requests."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr><th className="px-2 py-2 font-medium">Staff</th><th className="px-2 py-2 font-medium">Type</th><th className="px-2 py-2 font-medium">Dates</th><th className="px-2 py-2 font-medium">Days</th><th className="px-2 py-2 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-2 py-2">{r.user?.name ?? "—"}</td>
                    <td className="px-2 py-2">{r.leaveTypeName ?? "—"}</td>
                    <td className="px-2 py-2 text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</td>
                    <td className="px-2 py-2">{r.days}</td>
                    <td className="px-2 py-2"><Badge variant={VARIANT[r.status] ?? "secondary"}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {total > 0 && (
            <div className="mt-2 flex items-center justify-between">
              {/* What is SHOWN out of what MATCHES. A register that silently
                  truncates reads as a complete answer. */}
              <span className="text-xs text-muted-foreground">
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
                {filters.q || filters.status || filters.from || filters.to ? " matching" : ""}
              </span>
              {total > pageSize && (
                <span className="flex items-center gap-2">
                  <a
                    href={pageHref(page - 1)}
                    aria-disabled={page <= 1}
                    className={page <= 1 ? "pointer-events-none text-xs text-muted-foreground/40" : "text-xs underline underline-offset-2"}
                  >
                    Previous
                  </a>
                  <span className="text-xs text-muted-foreground">
                    Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
                  </span>
                  <a
                    href={pageHref(page + 1)}
                    aria-disabled={page * pageSize >= total}
                    className={page * pageSize >= total ? "pointer-events-none text-xs text-muted-foreground/40" : "text-xs underline underline-offset-2"}
                  >
                    Next
                  </a>
                </span>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Approvals happen in the Approvals inbox (head → HR → principal).</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Who&apos;s out (next 60 days)</p>
          {coverage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved leave in the window.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {coverage.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span>{r.user?.name ?? "—"} · {r.leaveTypeName ?? ""}</span>
                  <span className="text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
