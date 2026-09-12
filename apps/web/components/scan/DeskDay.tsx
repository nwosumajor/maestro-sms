"use client";

// =============================================================================
// The day at the desk — the movement log nothing could reach
// =============================================================================
// `GET /members/scan/today` existed, was permission-gated and audited, and was
// called by NO SCREEN. Its own docstring said it answers "who is on the
// premises, and what has the desk been doing" — a safeguarding question a gate
// log exists for — and there was no way to ask it.
//
// It also could not have answered. Measured on a 1,200-pupil school: 2,400
// scans in the day, a bare newest-first array capped at 200, so the response
// covered ELEVEN MINUTES of a nine-hour day and held ZERO check-ins.
//
// So the counts come first and are computed over the whole day in SQL: the
// question is answered before any row is read, and the log below is the
// evidence rather than the answer.
// =============================================================================

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import type { Serialized, ScanDayDto, ScanPurpose } from "@sms/types";
import { SCAN_PURPOSES, SCAN_PURPOSE_LABELS } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

type Day = Serialized<ScanDayDto>;

export function DeskDay() {
  const { timeOfDay } = useFormat();
  const [day, setDay] = React.useState<Day | null>(null);
  const [purpose, setPurpose] = React.useState<ScanPurpose | "">("");
  const [page, setPage] = React.useState(1);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (purpose) q.set("purpose", purpose);
      if (page > 1) q.set("page", String(page));
      const res = await fetch(`/api/sms/members/scan/today${q.toString() ? `?${q}` : ""}`, { cache: "no-store" });
      if (!res.ok) {
        // The server's own reason, with a hint only as a fallback.
        setErr(await readApiError(res, "Could not read today's movements."));
        return;
      }
      setDay((await res.json()) as Day);
      setErr(null);
    } finally {
      setBusy(false);
    }
  }, [purpose, page]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const counts = day?.counts;
  const pages = day ? Math.max(1, Math.ceil(day.total / day.pageSize)) : 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-3 text-base">
          <span>Today at the desk</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {err && <p className="text-sm text-destructive">{err}</p>}

        {/* THE ANSWER FIRST. Counted over the whole day in SQL, so it is not
            narrowed by the filter or the page below it. */}
        {counts && (
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="rounded-md border border-border px-2 py-1">
              <strong>{day?.onSite ?? 0}</strong> on site
            </span>
            {SCAN_PURPOSES.map((p) => (
              <span key={p} className="rounded-md border border-border px-2 py-1 text-muted-foreground">
                {SCAN_PURPOSE_LABELS[p]}: <strong className="text-foreground">{counts[p]}</strong>
              </span>
            ))}
          </div>
        )}
        {day && day.onSite > 0 && (
          <p className="text-xs text-muted-foreground">
            &ldquo;On site&rdquo; is check-ins minus check-outs — a floor, not a roll call: anyone who left
            without scanning out is still counted.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="desk-purpose">Show</label>
          <select
            id="desk-purpose"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={purpose}
            onChange={(e) => {
              setPage(1);
              setPurpose(e.target.value as ScanPurpose | "");
            }}
          >
            <option value="">Everything</option>
            {SCAN_PURPOSES.map((p) => (
              <option key={p} value={p}>{SCAN_PURPOSE_LABELS[p]}</option>
            ))}
          </select>
          {day && (
            <span className="text-xs text-muted-foreground">
              {day.total > day.shown ? `showing ${day.shown} of ${day.total}` : `${day.total} scan${day.total === 1 ? "" : "s"}`}
            </span>
          )}
        </div>

        {day && day.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans recorded today.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {(day?.items ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="font-medium">{s.memberName}</span>
                <span className="text-muted-foreground">{SCAN_PURPOSE_LABELS[s.purpose as ScanPurpose] ?? s.purpose}</span>
                <span className="tabular-nums text-muted-foreground">{timeOfDay(s.at)}</span>
              </li>
            ))}
          </ul>
        )}

        {/* A cap is only safe when the rest is reachable. */}
        {day && day.total > day.pageSize && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" disabled={page <= 1 || busy} onClick={() => setPage((n) => n - 1)}>
              ← newer
            </Button>
            <span>page {page} of {pages}</span>
            <Button size="sm" variant="outline" disabled={page >= pages || busy} onClick={() => setPage((n) => n + 1)}>
              older →
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
