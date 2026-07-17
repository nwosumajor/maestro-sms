"use client";

// Search / filter / pagination for the operator SCHOOL DIRECTORY. URL-driven
// (?q&plan&billing&status&sort&page) so the server component fetches exactly one
// page. Search also matches the proprietor's name/phone (server-side).

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PLANS = ["STANDARD", "PREMIUM", "ULTIMATE", "ENTERPRISE"] as const;
const BILLING = ["ACTIVE", "PAST_DUE", "CANCELED"] as const;

export function DirectoryFilterBar({
  q, plan, billing, status, sort, page, pageSize, total,
}: {
  q: string; plan: string; billing: string; status: string; sort: string;
  page: number; pageSize: number; total: number;
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState(q);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const go = (next: Partial<{ q: string; plan: string; billing: string; status: string; sort: string; page: number }>) => {
    const params = new URLSearchParams();
    const v = {
      q: (next.q ?? search).trim(),
      plan: next.plan ?? plan,
      billing: next.billing ?? billing,
      status: next.status ?? status,
      sort: next.sort ?? sort,
    };
    if (v.q) params.set("q", v.q);
    if (v.plan) params.set("plan", v.plan);
    if (v.billing) params.set("billing", v.billing);
    if (v.status) params.set("status", v.status);
    if (v.sort) params.set("sort", v.sort);
    const pg = next.page ?? 1; // any filter change resets to page 1
    if (pg > 1) params.set("page", String(pg));
    router.push(`/operator/schools${params.size ? `?${params.toString()}` : ""}`);
  };

  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-3 shadow-card">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: search });
        }}
      >
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="School, slug, owner name or phone…"
          className="h-9 w-64"
        />
        <Button type="submit" size="sm" variant="outline">Search</Button>
      </form>
      <select className={sel} value={plan} onChange={(e) => go({ plan: e.target.value })} aria-label="Plan">
        <option value="">All plans</option>
        {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select className={sel} value={billing} onChange={(e) => go({ billing: e.target.value })} aria-label="Billing status">
        <option value="">All billing</option>
        {BILLING.map((b) => <option key={b} value={b}>{b.replace("_", " ")}</option>)}
      </select>
      <select className={sel} value={status} onChange={(e) => go({ status: e.target.value })} aria-label="School status">
        <option value="">All schools</option>
        <option value="ACTIVE">Active</option>
        <option value="DISABLED">Disabled</option>
      </select>
      <select className={sel} value={sort} onChange={(e) => go({ sort: e.target.value })} aria-label="Sort">
        <option value="">Name A–Z</option>
        <option value="recent">Recently onboarded</option>
      </select>
      <span className="ml-auto text-xs text-muted-foreground">
        {total} school{total === 1 ? "" : "s"} · page {page}/{pages}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
          ← Prev
        </Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>
          Next →
        </Button>
      </div>
    </div>
  );
}
