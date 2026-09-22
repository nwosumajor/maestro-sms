"use client";

// =============================================================================
// LiveClassTable — the live-class diary and the recording library, in one table
// =============================================================================
// Columns are the facts somebody actually scans for: the COURSE and the TOPIC
// (a subject is not a lesson), when it starts, how long, whether it can be
// joined now, whether it can be played back, and when it was scheduled.
//
// PLAYBACK IS NOT A LINK. The row carries no URL: it POSTs for a short-lived
// inline grant, which is audited server-side, and drops it straight into a
// <video>. There is no href to copy, nothing in the markup that survives the
// page, and no download control. That is not a claim the video cannot be
// captured — anything a browser plays can be recorded off the screen, and this
// codebase treats client-side measures as friction, never enforcement — but it
// removes every easy path and makes each watch a recorded fact.
// =============================================================================

import type { LmsLiveSessionDto, LmsLiveSessionPageDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordingControl } from "@/components/lms/RecordingControl";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";
import { readJson } from "@/lib/read-json";
import { useFormat } from "@/components/shell/RegionProvider";

type Row = Serialized<LmsLiveSessionDto>;
type Page = Serialized<LmsLiveSessionPageDto>;

const mb = (bytes: number | null) => (bytes == null ? "" : `${(bytes / 1024 / 1024).toFixed(0)} MB`);

export function LiveClassTable({
  initial,
  filters,
  canManage,
}: {
  initial: Page;
  filters: { q: string; from: string; to: string; recorded: boolean };
  canManage: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const { region, dateTime, shortDate } = useFormat();
  const [q, setQ] = React.useState(filters.q);
  const [from, setFrom] = React.useState(filters.from);
  const [to, setTo] = React.useState(filters.to);
  const [playing, setPlaying] = React.useState<{ id: string; url: string; title: string } | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  /** Every filter is a URL — so a search is shareable, survives a refresh, and
   *  is answered by the SERVER rather than by narrowing the page in hand. */
  const apply = (next: Partial<{ q: string; from: string; to: string; recorded: string; page: string }>) => {
    const sp = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    // A new filter starts at page one: keeping the old page is how a reader
    // lands on an empty screen and concludes there is nothing there.
    if (!("page" in next)) sp.delete("page");
    router.push(`/live-classes${sp.toString() ? `?${sp}` : ""}`);
  };

  const play = async (row: Row) => {
    setBusy(row.id);
    setMsg(null);
    const res = await fetch(`/api/sms/live/${row.id}/recording/play`, { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      setMsg(await readApiError(res, "That recording could not be opened."));
      return;
    }
    const body = await readJson<{ url: string }>(res);
    if (!body?.url) {
      setMsg("That recording could not be opened.");
      return;
    }
    setPlaying({ id: row.id, url: body.url, title: `${row.subjectName ? `${row.subjectName} — ` : ""}${row.title}` });
  };

  const join = async (row: Row) => {
    setBusy(row.id);
    setMsg(null);
    const res = await fetch(`/api/sms/live/${row.id}/join`, { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      setMsg(await readApiError(res, "That class could not be joined."));
      return;
    }
    const body = await readJson<{ joinUrl: string }>(res);
    if (body?.joinUrl) window.open(body.joinUrl, "_blank", "noopener,noreferrer");
  };

  const pages = Math.max(Math.ceil(initial.total / initial.pageSize), 1);

  return (
    <div className="space-y-4">
      {/* --- search + filters ------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="lc-q">Search a topic</Label>
            <Input
              id="lc-q"
              value={q}
              placeholder="Photosynthesis"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply({ q })}
              className="w-56"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-from">From</Label>
            <Input id="lc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-to">To</Label>
            <Input id="lc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />
          </div>
          <Button type="button" onClick={() => apply({ q, from, to })}>
            Search
          </Button>
          {/* The filter the page is FOR: what can I go back and watch. */}
          <Button
            type="button"
            variant={filters.recorded ? "default" : "outline"}
            onClick={() => apply({ q, from, to, recorded: filters.recorded ? "" : "1" })}
          >
            {filters.recorded ? "Showing recorded only" : "Recorded only"}
          </Button>
          {(filters.q || filters.from || filters.to || filters.recorded) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setQ("");
                setFrom("");
                setTo("");
                apply({ q: "", from: "", to: "", recorded: "" });
              }}
            >
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {msg && <p className="text-sm text-destructive">{msg}</p>}

      {/* --- the player ------------------------------------------------------ */}
      {playing && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{playing.title}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </div>
            {/* `controlsList`/`disablePictureInPicture`/no context menu are
                FRICTION, not enforcement — the enforcement is that the server
                only ever signs an inline grant, and it expires. Stated plainly
                below so nobody mistakes the one for the other. */}
            <video
              key={playing.id}
              src={playing.url}
              controls
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              className="w-full rounded-md bg-black"
            />
            <p className="text-xs text-muted-foreground">
              This recording plays here and is not offered for download. It is a lesson recording of
              named pupils — every play is recorded against your name.
            </p>
          </CardContent>
        </Card>
      )}

      {/* --- the table ------------------------------------------------------- */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Course &amp; topic</th>
                  <th className="px-4 py-2 text-left font-medium">Class</th>
                  <th className="px-4 py-2 text-left font-medium">Starts</th>
                  <th className="px-4 py-2 text-left font-medium">Duration</th>
                  <th className="px-4 py-2 text-left font-medium">Live</th>
                  <th className="px-4 py-2 text-left font-medium">Playback</th>
                  <th className="px-4 py-2 text-left font-medium">Scheduled</th>
                  {canManage && <th className="px-4 py-2 text-left font-medium">Joined</th>}
                </tr>
              </thead>
              <tbody>
                {initial.rows.length === 0 ? (
                  <tr>
                    <td colSpan={canManage ? 8 : 7} className="px-4 py-6 text-center text-muted-foreground">
                      {filters.recorded
                        ? "No recorded lessons match that search."
                        : "No live classes match that search."}
                    </td>
                  </tr>
                ) : (
                  initial.rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-2.5">
                        {/* The SUBJECT is the course; the title is the topic.
                            Showing only one of them is what made a list of
                            "Photosynthesis" and "Algebra II" unreadable. */}
                        <div className="font-medium">{r.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.subjectName ?? "No subject"} · {r.hostName}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.className ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{dateTime(r.startsAt)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{r.durationMinutes} min</td>
                      <td className="px-4 py-2.5">
                        {r.joinable ? (
                          <Button size="sm" disabled={busy === r.id} onClick={() => join(r)}>
                            {busy === r.id ? "Opening…" : "Join live"}
                          </Button>
                        ) : (
                          <Badge variant="outline">{r.status === "SCHEDULED" ? "Not yet" : r.status.toLowerCase()}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.hasRecording ? (
                          <div className="space-y-0.5">
                            <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => play(r)}>
                              {busy === r.id ? "Opening…" : "Playback"}
                            </Button>
                            <div className="text-xs text-muted-foreground">
                              {mb(r.recordingSizeBytes)}
                              {/* A pupil revising deserves to know how long they
                                  have, rather than finding it gone. */}
                              {r.recordingExpiresAt ? ` · until ${shortDate(r.recordingExpiresAt)}` : ""}
                            </div>
                            {/* A duty given with a control is taken away with
                                one: whoever can attach it can take it down. */}
                            {canManage && (
                              <RecordingControl
                                sessionId={r.id}
                                title={r.title}
                                hasRecording
                                onChanged={() => router.refresh()}
                                layout="row"
                              />
                            )}
                          </div>
                        ) : r.recordingRemovedAt ? (
                          // REMOVED and NEVER RECORDED are different facts, and
                          // only one of them needs explaining.
                          <span className="text-xs text-muted-foreground">
                            Removed {shortDate(r.recordingRemovedAt)}
                          </span>
                        ) : canManage ? (
                          // THE WAY TO FINISH IT. This page is the one called
                          // "Live classes" in the nav and it lists the ENDED
                          // sessions — precisely the rows that need a recording
                          // — so showing a teacher an em-dash here and keeping
                          // the only upload control three clicks away inside a
                          // class's Learning content tab is a control with no
                          // door. Same component as that panel, not a second
                          // copy of the three-step upload.
                          <RecordingControl
                            sessionId={r.id}
                            title={r.title}
                            hasRecording={false}
                            onChanged={() => router.refresh()}
                            layout="row"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{shortDate(r.createdAt)}</td>
                      {canManage && (
                        <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{r.attendeeCount}</td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* THE TOTAL, always — a page without one reads as the whole record. */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
            <span className="text-muted-foreground tabular-nums">
              {initial.total === 0
                ? "No sessions"
                : `Showing ${(initial.page - 1) * initial.pageSize + 1}–${Math.min(initial.page * initial.pageSize, initial.total)} of ${initial.total}`}
            </span>
            {pages > 1 && (
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={initial.page <= 1}
                  onClick={() => apply({ q, from, to, recorded: filters.recorded ? "1" : "", page: String(initial.page - 1) })}
                >
                  Newer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={initial.page >= pages}
                  onClick={() => apply({ q, from, to, recorded: filters.recorded ? "1" : "", page: String(initial.page + 1) })}
                >
                  Older
                </Button>
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <span className="sr-only">{region.timezone}</span>
    </div>
  );
}
