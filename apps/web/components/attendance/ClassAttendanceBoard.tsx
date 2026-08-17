"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Row = {
  classId: string;
  className: string;
  supervisorId: string | null;
  supervisorName: string | null;
  canTake: boolean;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  ratePct: number | null;
  registersTaken: number;
};

/**
 * Attendance BY CLASS — the senior-staff view.
 *
 * Senior staff open this to see the school class by class and drill into whichever
 * looks wrong; a school administrator sees the same rows plus a Take register
 * affordance for covering an absent supervisor.
 *
 * `canTake` comes from the SERVER, per row. The UI never re-derives the permission
 * rule, so it cannot offer a button the API will refuse — and when the rule changes,
 * it changes in one place.
 */
type Board = {
  from: string;
  to: string;
  termId: string | null;
  termName: string | null;
  source: "rollup" | "live";
  classes: Row[];
};
type Term = {
  id: string;
  name: string;
  sessionName: string;
  isCurrent: boolean;
  ended: boolean;
  rolledUp: boolean;
};

export function ClassAttendanceBoard() {
  const [data, setData] = React.useState<Board | null>(null);
  const [terms, setTerms] = React.useState<Term[]>([]);
  const [termId, setTermId] = React.useState<string>("");
  const [sort, setSort] = React.useState<"name" | "rate">("rate");

  // Terms are fetched once: three a year means fifteen rows after five years.
  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/sms/attendance/terms");
      if (live && res.ok) setTerms((await res.json()) as Term[]);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Switching term used to blank the board to a loading state and rebuild it.
  // That reads as the page breaking and re-forming for what is a filter change —
  // and it is the single most "laggy" thing here, because the eye has to
  // re-acquire the table every time. The previous figures stay on screen, dimmed
  // and marked busy, and are replaced in place when the new ones land.
  const [busy, setBusy] = React.useState(false);
  // Set when a refresh fails. The figures on screen stay — they were true when
  // they were fetched — but they must not be presented as current.
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    setBusy(true);
    (async () => {
      const res = await fetch(`/api/sms/attendance/by-class${termId ? `?termId=${encodeURIComponent(termId)}` : ""}`);
      if (!live) return;
      if (res.ok) {
        setData(await res.json());
        setFailed(false);
      } else {
        // A failed refresh used to be replaced with
        // `{ source: "live", classes: [] }` — a fabricated reading that renders
        // as every class at zero attendance and LABELS it live. The figures
        // already on screen are kept (which is this component's own design
        // while busy) and the failure is stated instead.
        setFailed(true);
      }
      setBusy(false);
    })();
    return () => {
      live = false;
    };
  }, [termId]);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const r = [...data.classes];
    // Worst attendance first by default: the reason to open this page is to find
    // the class that needs attention, not to read an alphabetical list.
    if (sort === "rate") {
      r.sort((a, b) => (a.ratePct ?? 999) - (b.ratePct ?? 999) || a.className.localeCompare(b.className));
    } else {
      r.sort((a, b) => a.className.localeCompare(b.className));
    }
    return r;
  }, [data, sort]);

  // Deliberately renders while loading a different term rather than unmounting: a
  // board that vanishes on every term change reads as an error.
  const untaken = rows.filter((r) => r.registersTaken === 0).length;
  if (data && rows.length === 0 && !termId) return null;

  return (
    <Card aria-busy={busy}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Attendance by class</CardTitle>
            <CardDescription>
              {data ? (
                <>
                  {data.termName ?? "This term"} ({data.from} – {data.to}). Open a class to see its register.
                  {untaken > 0 ? ` ${untaken} class${untaken === 1 ? " has" : "es have"} no register at all.` : ""}
                  {/* Past terms are frozen by the term lock, which is what lets them
                      be served from the precomputed rollup. Saying so is the honest
                      version of "why was that instant". */}
                  {data.source === "rollup" ? " Figures for this ended term are precomputed." : ""}
                  {busy ? " Updating…" : ""}
                  {failed ? " Couldn\u2019t refresh — these figures may be out of date." : ""}
                </>
              ) : (
                failed ? "Couldn\u2019t load attendance." : "Loading…"
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {terms.length > 0 && (
              <select
                aria-label="Term"
                value={termId}
                onChange={(e) => setTermId(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Current term</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.sessionName ? `${t.sessionName} — ` : ""}
                    {t.name}
                    {t.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-1 rounded-md border p-1">
              <Button size="sm" variant={sort === "rate" ? "default" : "ghost"} onClick={() => setSort("rate")}>
                Lowest first
              </Button>
              <Button size="sm" variant={sort === "name" ? "default" : "ghost"} onClick={() => setSort("name")}>
                By name
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className={(busy ? "opacity-60 " : "") + "transition-opacity overflow-x-auto p-0"}>
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Class</th>
              <th className="px-4 py-2.5 font-medium">Supervisor</th>
              <th className="px-4 py-2.5 text-right font-medium">Attendance</th>
              <th className="px-4 py-2.5 text-right font-medium">Absent</th>
              <th className="px-4 py-2.5 text-right font-medium">Registers</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No attendance was recorded in {data.termName ?? "this window"}.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.classId} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2.5 font-medium">
                  {/* /classes/<id> is not a route — the class pages are /info,
                      /roster and /content. */}
                  <Link href={`/classes/${r.classId}/info`} className="text-primary hover:underline">
                    {r.className}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {r.supervisorName ?? <Badge variant="outline">none assigned</Badge>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {r.ratePct == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={r.ratePct < 85 ? "font-semibold text-destructive" : ""}>{r.ratePct}%</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.absent}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {/* No register at all is a different problem from poor attendance,
                      and the one that is still fixable today. */}
                  {r.registersTaken === 0 ? (
                    <Badge variant="destructive">none taken</Badge>
                  ) : (
                    <span className="text-muted-foreground">{r.registersTaken}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.canTake ? (
                    // Lands on the register form with THIS class already chosen —
                    // the point of clicking the row was that class.
                    <Link href={`/attendance?classId=${r.classId}`}>
                      <Button size="sm" variant="outline">
                        Take register
                      </Button>
                    </Link>
                  ) : (
                    // Says WHY rather than showing a disabled button with no reason.
                    <span className="text-xs text-muted-foreground">view only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
