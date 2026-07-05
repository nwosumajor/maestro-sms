"use client";

import type { AuditLogRowDto, Serialized } from "@sms/types";
import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { dateTime } from "@/lib/format";
import { readApiError } from "@/lib/api-error";

type Row = Serialized<AuditLogRowDto>;

const isSecurity = (a: string) => a.startsWith("security.") || a.includes("medical") || a.includes("download");

/** Paginated audit table: renders the first server-fetched page, then appends
 *  further pages via the keyset cursor on demand (no offset scan). */
export function AuditLog({
  initial,
  nextCursor,
  query,
}: {
  initial: Row[];
  nextCursor: string | null;
  query: string;
}) {
  const [rows, setRows] = React.useState<Row[]>(initial);
  const [cursor, setCursor] = React.useState<string | null>(nextCursor);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Reset when the server sends a new first page (e.g. a filter changed).
  React.useEffect(() => {
    setRows(initial);
    setCursor(nextCursor);
    setErr(null);
  }, [initial, nextCursor]);

  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    setErr(null);
    const sep = query ? "&" : "";
    const res = await fetch(`/api/sms/security/audit?${query}${sep}cursor=${encodeURIComponent(cursor)}`);
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    const page = (await res.json()) as { entries: Row[]; nextCursor: string | null };
    setRows((prev) => [...prev, ...page.entries]);
    setCursor(page.nextCursor);
  };

  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Entity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{dateTime(r.createdAt)}</td>
                <td className="px-4 py-2">{r.actorName}</td>
                <td className="px-4 py-2">
                  <code className={isSecurity(r.action) ? "text-destructive" : ""}>{r.action}</code>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{r.entity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center gap-3 px-4 py-3">
          {cursor ? (
            <Button variant="outline" size="sm" onClick={loadMore} disabled={busy}>
              {busy ? "Loading…" : "Load more"}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">End of log · {rows.length} shown</span>
          )}
          {err && <span className="text-xs text-destructive">{err}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
