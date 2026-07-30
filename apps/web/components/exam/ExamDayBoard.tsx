"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ExamDayDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Board = Serialized<ExamDayDto>;

/** How often the board re-reads while it is on screen. Exam mornings are the one
 *  time staff leave a screen open and expect it to be current; 20s is frequent
 *  enough to feel live without hammering the API from every invigilator's phone. */
const REFRESH_MS = 20_000;

/**
 * The EXAM DAY half of the console.
 *
 * The planning list answers "what is scheduled?". Walking the halls on exam
 * morning you are asking something else entirely: is this room started, how many
 * have submitted, and — the one thing that cannot be repaired afterwards — is
 * anyone actually invigilating it? So the warnings come precomputed from the
 * server and the unstaffed halls are pulled to the top.
 */
export function ExamDayBoard({ canRelease }: { canRelease: boolean }) {
  const router = useRouter();
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [board, setBoard] = React.useState<Board | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async (d: string) => {
    const res = await fetch(`/api/sms/exams/day?date=${d}`);
    if (res.ok) setBoard((await res.json()) as Board);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    setLoading(true);
    void load(date);
    const t = setInterval(() => void load(date), REFRESH_MS);
    return () => clearInterval(t);
  }, [date, load]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    setMsg(res.ok ? ok : res.error ?? "Failed.");
    if (res.ok) {
      await load(date);
      router.refresh();
    }
  };

  // Problems first. An exam officer with fifteen halls needs the two that are
  // wrong, not a list in timetable order.
  const halls = React.useMemo(() => {
    if (!board) return [];
    const severity = (h: Board["halls"][number]) => (h.warning ? 0 : h.noInvigilator ? 1 : h.noSeats ? 2 : 3);
    return [...board.halls].sort((a, b) => severity(a) - severity(b) || a.startsAt.localeCompare(b.startsAt));
  }, [board]);

  const problems = halls.filter((h) => h.warning || h.noInvigilator || h.noSeats).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <CardTitle className="text-base">Exam day</CardTitle>
              <CardDescription>
                Every hall on one date, refreshing itself. Halls needing attention are listed first.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="rounded-md border bg-background p-1.5 text-sm"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <Button size="sm" variant="outline" onClick={() => void load(date)}>
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !board ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : halls.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled on this date.</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {halls.length} hall(s){problems > 0 ? ` · ${problems} needing attention` : " · all set"}
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {halls.map((h) => (
                  <div
                    key={h.sittingId}
                    className={`rounded-md border p-3 ${
                      h.warning ? "border-destructive/60 bg-destructive/5" : h.noInvigilator ? "border-amber-500/50" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {h.hall}
                          <span className="text-muted-foreground"> · {h.startsAt}–{h.endsAt}</span>
                        </p>
                        <p className="truncate text-sm">
                          {h.title}
                          {h.subject ? <span className="text-muted-foreground"> · {h.subject}</span> : null}
                        </p>
                      </div>
                      {/* A filled dot reads as "running" at a glance from across a
                          corridor; the text is there for anyone who needs it. */}
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {h.cbtStatus === null ? "paper" : h.released ? "● live" : "○ not released"}
                      </span>
                    </div>

                    <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                      {h.capacity > 0 ? `${h.seated}/${h.capacity} seated` : `${h.seated} seated`} · {h.invigilators} invigilator(s)
                      {h.released ? ` · ${h.submitted}/${h.started} submitted` : ""}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {h.warning && <Badge variant="destructive">{h.warning}</Badge>}
                      {h.noInvigilator && <Badge variant="outline">no invigilator</Badge>}
                      {h.noSeats && <Badge variant="outline">nobody seated</Badge>}
                      {canRelease && h.cbtStatus === "PUBLISHED" && !h.released && (
                        <Button size="sm" disabled={busy} onClick={() => act(() => postSms(`exams/${h.sittingId}/release`, {}), "Released.")}>
                          Release
                        </Button>
                      )}
                      <a className="text-xs text-muted-foreground underline hover:text-foreground" href={`/api/sms/exams/${h.sittingId}/attendance.pdf`}>
                        attendance sheet
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
