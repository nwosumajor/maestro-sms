"use client";

// What each scheduled job last did, and whether it is still doing it.
//
// The three states this has to keep apart, because they look identical from a
// log file and only one of them is fine:
//
//   RAN, found nothing   — normal. "0 billed" is a real answer.
//   LATE                 — ran once, and not since. The scheduler has stopped.
//   NEVER RAN            — not wired up at all, or has never fired since deploy.
//
// The whole reason this page exists is that the platform could not tell them
// apart. So the wording never says "0" on its own: it says what the job found,
// or says plainly that it has not run.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/components/shell/RegionProvider";
import { sendSms } from "@/components/game/play-ui";
import { hasPermission, type Permission } from "@/lib/permissions";

export type JobStatus = {
  key: string;
  label: string;
  everyMinutes: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOk: boolean | null;
  lastTrigger: string | null;
  lastSummary: unknown;
  lastError: string | null;
  overdue: boolean;
  neverRun: boolean;
  runsInDay: number;
  expectedInDay: number;
  overrunning: boolean;
  manual?: {
    path: string;
    permission: string;
    scope: "PLATFORM" | "SCHOOL";
    where?: string;
  };
};

const cadence = (m: number) =>
  m >= 1440 ? `every ${Math.round(m / 1440)} day${m >= 2880 ? "s" : ""}` : `every ${m} min`;

/** The job's own result object, as a sentence a person can read. */
function summarise(s: unknown): string {
  if (s == null || typeof s !== "object") return "—";
  const entries = Object.entries(s as Record<string, unknown>).filter(
    ([, v]) => typeof v === "number" || typeof v === "string",
  );
  if (entries.length === 0) return "nothing to report";
  return entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

export function JobsTable({ jobs, permissions }: { jobs: JobStatus[]; permissions: string[] }) {
  const { shortDate } = useFormat();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<{ key: string; text: string; ok: boolean } | null>(null);

  /**
   * Run a sweep by hand.
   *
   * Only offered for PLATFORM-scoped jobs. A school-scoped sweep pressed here
   * would run inside the PLATFORM's own org and report "0 found" — an answer
   * that looks like success and means nothing — so those say where their control
   * lives instead.
   */
  const runNow = async (job: JobStatus) => {
    if (!job.manual) return;
    setBusy(job.key);
    setNote(null);
    const res = await sendSms(job.manual.scope === "PLATFORM" ? "POST" : "POST", job.manual.path);
    setBusy(null);
    setNote({
      key: job.key,
      ok: res.ok,
      text: res.ok ? summarise(res.data) : (res.error ?? "It did not run."),
    });
    // The row's own state is what the operator came here to read, so refresh it
    // rather than leaving a stale "Late" beside a run that just succeeded.
    if (res.ok) router.refresh();
  };
  const when = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
    return shortDate(iso);
  };

  // Problems first. An operator opening this page is asking "is anything
  // wrong?", and making them scan thirteen rows for it is the wrong answer.
  // A job firing far more often than declared is a fault too, and the one this
  // page could not see: it asks whether a job ran RECENTLY, so a sweep running
  // sixty times an hour was the healthiest-looking row here. That is how a stale
  // every-minute schedule hid for 874 firings.
  const wrong = (j: JobStatus) => j.neverRun || j.overdue || j.lastOk === false || j.overrunning;
  const sorted = [...jobs].sort((a, b) => Number(wrong(b)) - Number(wrong(a)));
  const problems = sorted.filter(wrong).length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {problems === 0
          ? `All ${jobs.length} jobs have run recently and finished cleanly.`
          : `${problems} of ${jobs.length} job${problems === 1 ? "" : "s"} need${problems === 1 ? "s" : ""} attention.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Runs</th>
              <th className="px-3 py-2 font-medium">Last run</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">What it did</th>
              <th className="px-3 py-2 font-medium">Run</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => (
              <tr key={j.key} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{j.label}</span>
                  <div className="text-xs text-muted-foreground">{j.key}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {cadence(j.everyMinutes)}
                  {/* What it ACTUALLY did, beside what it should. A schedule
                      changed in the code does not move the old one in Redis, so
                      these two can disagree without anything looking broken. */}
                  <div className={j.overrunning ? "text-xs text-destructive" : "text-xs"}>
                    {j.runsInDay} run{j.runsInDay === 1 ? "" : "s"} in 24h
                    {j.overrunning ? ` — expected about ${j.expectedInDay}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {when(j.lastStartedAt)}
                  {j.lastTrigger === "MANUAL" && (
                    // A run somebody triggered by hand is not evidence the timer
                    // works, which is the question this page answers.
                    <div className="text-xs">triggered by hand</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {j.neverRun ? (
                    <Badge variant="destructive">Never run</Badge>
                  ) : j.lastOk === false ? (
                    <Badge variant="destructive">Failed</Badge>
                  ) : j.overdue ? (
                    <Badge variant="destructive">Late</Badge>
                  ) : j.overrunning ? (
                    <Badge variant="destructive">Too often</Badge>
                  ) : (
                    <Badge variant="secondary">OK</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {j.overrunning ? (
                    <span className="text-destructive">
                      Firing far more often than its schedule says. Usually a second, older
                      repeatable left in Redis by a cron change — it is removed at the next restart.
                    </span>
                  ) : j.neverRun ? (
                    <span>
                      No record of this job ever running. Check the scheduler is registered and the
                      worker is up.
                    </span>
                  ) : j.lastError ? (
                    <span className="text-destructive">{j.lastError.slice(0, 160)}</span>
                  ) : (
                    summarise(j.lastSummary)
                  )}
                  {note?.key === j.key && (
                    <div className={note.ok ? "mt-1 text-xs text-primary" : "mt-1 text-xs text-destructive"}>
                      {note.ok ? `Ran just now — ${note.text}` : note.text}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {!j.manual ? (
                    // Timer-only, and the reason belongs on the screen: rolling a
                    // partition forward outside its window creates an empty one.
                    <span className="text-xs text-muted-foreground">On a timer only</span>
                  ) : j.manual.scope === "SCHOOL" ? (
                    <span className="text-xs text-muted-foreground">
                      Per school{j.manual.where ? ` — ${j.manual.where}` : ""}
                    </span>
                  ) : !hasPermission(permissions, j.manual.permission as Permission) ? (
                    <span className="text-xs text-muted-foreground">Needs {j.manual.permission}</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => runNow(j)}
                    >
                      {busy === j.key ? "Running…" : "Run now"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
