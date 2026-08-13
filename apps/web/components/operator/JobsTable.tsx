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
import { Badge } from "@/components/ui/badge";
import { useFormat } from "@/components/shell/RegionProvider";

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

export function JobsTable({ jobs }: { jobs: JobStatus[] }) {
  const { shortDate } = useFormat();
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
  const sorted = [...jobs].sort(
    (a, b) =>
      Number(b.neverRun || b.overdue || b.lastOk === false) -
      Number(a.neverRun || a.overdue || a.lastOk === false),
  );
  const problems = sorted.filter((j) => j.neverRun || j.overdue || j.lastOk === false).length;

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
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => (
              <tr key={j.key} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{j.label}</span>
                  <div className="text-xs text-muted-foreground">{j.key}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{cadence(j.everyMinutes)}</td>
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
                  ) : (
                    <Badge variant="secondary">OK</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {j.neverRun ? (
                    <span>
                      No record of this job ever running. Check the scheduler is registered and the
                      worker is up.
                    </span>
                  ) : j.lastError ? (
                    <span className="text-destructive">{j.lastError.slice(0, 160)}</span>
                  ) : (
                    summarise(j.lastSummary)
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
