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
import { interpretApiError } from "@/lib/api-error";
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
  const error = interpretApiError(res.status, Array.isArray(j?.message) ? j.message.join(", ") : j?.message);
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
  const [note, setNote] = React.useState<string | null>(null);

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

  /**
   * Copy this item onto every other arm of the same stream.
   *
   * Distinct from Clone, which makes one copy in one class. The arms of a stream
   * teach the same thing, so writing a note once and copying it is the ordinary
   * case; doing it one class at a time is where twelve notes became twenty-four
   * operations. Each copy lands as a DRAFT in its arm and keeps its subject and
   * term tag, so it still counts toward the report card there.
   */
  async function copyToArms() {
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/content/${contentId}/copy-to-arms`, {});
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    const d = r.data as { copied: Array<{ className: string }>; skipped: Array<{ className: string; reason: string }> };
    // REPORTS WHAT IT DID NOT DO, per arm and why — "copied to 2 arms" with a
    // third silently skipped is the failure this codebase keeps recording.
    setNote(
      `Copied to ${d.copied.length === 0 ? "no arms" : d.copied.map((c) => c.className).join(", ")}.` +
        (d.skipped.length ? ` Skipped: ${d.skipped.map((x) => `${x.className} (${x.reason})`).join("; ")}` : ""),
    );
    onChanged();
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
      {note && <p className="max-w-sm text-right text-xs text-muted-foreground">{note}</p>}
      <div className="flex items-center gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={clone} disabled={busy}>
          Clone
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => void copyToArms()} disabled={busy}>
          Copy to arms
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
