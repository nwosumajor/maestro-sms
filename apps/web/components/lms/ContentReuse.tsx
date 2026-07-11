"use client";

// =============================================================================
// ContentItemTools — clone + version history/revert for one LMS content item
// =============================================================================
// Staff-only (the API gates on lms.content.write and 404s a non-staff-of-class).
// Clone makes a fresh DRAFT copy; History lists the append-only revisions and,
// for still-editable content, offers Revert. All writes go through the BFF; the
// API is authoritative.
// =============================================================================

import type { LmsRevisionDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";

type Rev = Serialized<LmsRevisionDto>;

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false as const, error };
}

export function ContentItemTools({
  contentId,
  editable,
  onChanged,
}: {
  contentId: string;
  editable: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [revs, setRevs] = React.useState<Rev[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function loadHistory() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setErr(null);
    const r = await req("GET", `/content/${contentId}/revisions`);
    if (r.ok) setRevs(r.data as Rev[]);
    else setErr(r.error);
  }

  async function clone() {
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/content/${contentId}/clone`, {});
    setBusy(false);
    if (r.ok) onChanged();
    else setErr(r.error);
  }

  async function revert(revisionId: string) {
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/content/${contentId}/revert/${revisionId}`);
    setBusy(false);
    if (r.ok) {
      const h = await req("GET", `/content/${contentId}/revisions`);
      if (h.ok) setRevs(h.data as Rev[]);
      onChanged();
    } else setErr(r.error);
  }

  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={clone} disabled={busy}>
          Clone
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={loadHistory}>
          {open ? "Hide history" : "History"}
        </Button>
      </div>
      {open && (
        <div className="w-full max-w-sm rounded-md border bg-muted/30 p-2 text-xs">
          {revs === null && !err && <p className="text-muted-foreground">Loading…</p>}
          {revs && revs.length === 0 && <p className="text-muted-foreground">No history yet.</p>}
          {revs && revs.length > 0 && (
            <ul className="space-y-1">
              {revs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">v{r.version}</span> · {r.note ?? "—"}
                    <span className="text-muted-foreground"> · {r.authorName}</span>
                  </span>
                  {editable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2"
                      disabled={busy}
                      onClick={() => revert(r.id)}
                    >
                      Revert
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
