"use client";

// Search + pagination for the operator message-credit oversight panel. State
// lives in the URL (?q&page), mirroring TenantFilterBar's pattern.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MessageCreditFilterBar({
  q,
  page,
  pageSize,
  total,
}: {
  q: string;
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState(q);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const go = (next: { q?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nq = next.q ?? search;
    if (nq.trim()) params.set("q", nq.trim());
    const pg = next.page ?? 1;
    if (pg > 1) params.set("page", String(pg));
    router.push(`/operator/message-credits${params.size ? `?${params.toString()}` : ""}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-3 shadow-card">
      <form
        onSubmit={(e) => { e.preventDefault(); go({ q: search, page: 1 }); }}
        className="flex flex-1 items-center gap-2"
      >
        <Input
          aria-label="Search schools"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by school name…"
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline">Search</Button>
        {q && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { setSearch(""); go({ q: "", page: 1 }); }}>
            Clear
          </Button>
        )}
      </form>
      <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
        <span className="tnum">{total.toLocaleString()} school{total === 1 ? "" : "s"} · page {page}/{pages}</span>
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>← Prev</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>Next →</Button>
      </div>
    </div>
  );
}
