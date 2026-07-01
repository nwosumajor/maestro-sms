"use client";

// Super_admin cross-tenant audit console. Filter every change/approval across all
// customer schools; each row identifies the actor (name + email + unique id + roles)
// and school for investigation. Export the current view as a CSV report.

import * as React from "react";
import type { PlatformAuditEntryDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTime } from "@/lib/format";

type Entry = Serialized<PlatformAuditEntryDto>;
type Tenant = { id: string; name: string };

const ROLES = ["principal", "school_admin", "head_teacher", "head_admin", "hr_manager", "accountant", "teacher", "board", "student", "parent"];

const EMPTY = { schoolId: "", role: "", actorEmail: "", action: "", from: "", to: "" };

const PAGE = 50;
type Page = { entries: Entry[]; nextCursor: string | null };

export function PlatformAudit({ tenants, initial, initialCursor }: { tenants: Tenant[]; initial: Entry[]; initialCursor: string | null }) {
  const [f, setF] = React.useState(EMPTY);
  const [rows, setRows] = React.useState<Entry[]>(initial);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  // Query string for the CURRENT filters (export uses this; list adds a cursor).
  const qs = React.useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p.toString();
  }, [f]);

  const fetchPage = async (cur: string | null): Promise<Page | null> => {
    const p = new URLSearchParams(qs);
    p.set("limit", String(PAGE));
    if (cur) p.set("cursor", cur);
    const res = await fetch(`/api/sms/operator/audit?${p.toString()}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Page) : null;
  };

  const apply = async () => {
    setBusy(true);
    const page = await fetchPage(null);
    setBusy(false);
    if (page) {
      setRows(page.entries);
      setCursor(page.nextCursor);
    }
  };
  const loadMore = async () => {
    setBusy(true);
    const page = await fetchPage(cursor);
    setBusy(false);
    if (page) {
      setRows((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    }
  };
  const reset = () => setF(EMPTY);

  const inputCls = "h-9 rounded-lg border border-input bg-card px-3 text-sm shadow-xs";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Platform audit trail</CardTitle>
          <CardDescription>
            Every change and approval across all schools, attributed to the actor&apos;s email + unique id. Filter,
            then export a report for investigation.
          </CardDescription>
        </div>
        <a href={`/api/sms/operator/audit/export.csv?${qs}`}>
          <Button variant="outline" size="sm">Export CSV</Button>
        </a>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-2">
          <select value={f.schoolId} onChange={set("schoolId")} className={inputCls} aria-label="School">
            <option value="">All schools</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select value={f.role} onChange={set("role")} className={inputCls} aria-label="Actor role">
            <option value="">Any role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <Input value={f.actorEmail} onChange={set("actorEmail")} placeholder="Actor email" className="h-9 w-44" />
          <Input value={f.action} onChange={set("action")} placeholder="Action contains…" className="h-9 w-44" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">From<input type="date" value={f.from} onChange={set("from")} className={inputCls} /></label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">To<input type="date" value={f.to} onChange={set("to")} className={inputCls} /></label>
          <Button size="sm" onClick={apply} disabled={busy}>{busy ? "Loading…" : "Apply"}</Button>
          <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Showing {rows.length} {rows.length === 1 ? "entry" : "entries"} (newest first){cursor ? ", more available" : ""}. Export CSV for the full filtered set.
        </p>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">School</th>
                <th className="py-2 pr-3 font-medium">Actor</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                <th className="py-2 font-medium">Entity</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No audit entries match these filters.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50 align-top">
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground">{dateTime(r.createdAt)}</td>
                  <td className="py-2 pr-3">{r.schoolName}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{r.actorName}</div>
                    <div className="text-xs text-muted-foreground">{r.actorEmail}</div>
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      <span className="font-mono text-[0.65rem] text-muted-foreground">{r.actorUniqueId}</span>
                      {r.actorRoles.map((role) => (
                        <Badge key={role} variant="outline" className="px-1 py-0 text-[0.6rem]">{role}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-3"><span className="font-mono text-xs">{r.action}</span></td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {r.entity}
                    {r.entityId ? <span className="font-mono"> · {r.entityId.slice(0, 8)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {cursor && (
          <div className="flex justify-center pt-1">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={busy}>
              {busy ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
