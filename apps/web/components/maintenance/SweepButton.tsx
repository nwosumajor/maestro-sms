"use client";

// =============================================================================
// The button for a sweep a school can run itself
// =============================================================================
// Every scheduled job in `SCHEDULED_JOBS` that a SCHOOL can press names, in
// `where`, the screen its control lives on. Several named a screen that had no
// such control: the overdue-boarder check, the stale-record nudge, the
// end-of-term archive, the breach-deadline clock, the declined-applicant purge
// and the telemetry purge. The endpoint existed, the operator console pointed at
// it, and there was nothing to press — a route no screen can reach.
//
// ONE component rather than six near-identical ones, because a control written
// six times is right five times.
//
// The wording of each result lives HERE, keyed by path, and not in a `describe`
// prop. Every one of these buttons is placed on a SERVER component, and a
// function cannot cross that boundary: the page compiled, typechecked and built,
// and then threw "Functions cannot be passed directly to Client Components"
// during SSR — five pages rendering their loading shell and nothing else. The
// props a server page passes must all be serialisable.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

/** Wraps a typed formatter so the map can hold them all with one cast each. */
const fmt = <T,>(f: (r: T) => string) => (r: unknown) => f(r as T);

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * What each sweep DID, in the presser's own terms — and what it did NOT do.
 * A run that could not finish its work must say so here; "Done." is how a
 * partial sweep passes for a complete one.
 */
const DESCRIBE: Record<string, (r: unknown) => string> = {
  "attendance/register-reminder/run": fmt<{
    outstanding: number;
    notified: number;
    unreachable: number;
    failed: number;
  }>((r) =>
    r.outstanding === 0
      ? "Every register has been taken today — nobody needed reminding."
      : [
          `${r.outstanding} ${plural(r.outstanding, "register")} still outstanding.`,
          r.notified > 0 ? `${r.notified} ${plural(r.notified, "teacher")} reminded.` : "",
          // NAMED, not folded into a silence: these are the ones that will go on
          // being missed, because no reminder can reach them.
          r.unreachable > 0
            ? `${r.unreachable} ${plural(r.unreachable, "register has", "registers have")} no class teacher to remind — assign one on the class page.`
            : "",
          r.failed > 0 ? `${r.failed} could not be checked.` : "",
        ]
          .filter(Boolean)
          .join(" "),
  ),
  "privacy/compliance/breach-deadlines/run": fmt<{
    scanned: number;
    warned: number;
    overdue: number;
    failed: number;
  }>((r) =>
    r.scanned === 0
      ? "No breach is currently waiting on a notification decision."
      : [
          `Checked ${r.scanned}.`,
          r.warned > 0 ? `${r.warned} approaching the deadline — warned.` : "",
          r.overdue > 0 ? `${r.overdue} already past it.` : "",
          r.failed > 0 ? `${r.failed} could not be checked and will be retried.` : "",
          r.warned === 0 && r.overdue === 0 && r.failed === 0 ? "None is near its deadline." : "",
        ]
          .filter(Boolean)
          .join(" "),
  ),

  "documents/retention/run": fmt<{
    applications: number;
    filesPurged: number;
    failed: number;
    backlog: number;
  }>((r) =>
    r.applications === 0
      ? "No declined application has passed its retention window."
      : [
          `Examined ${r.applications}; removed ${r.filesPurged} ${plural(r.filesPurged, "file")}.`,
          r.failed > 0 ? `${r.failed} could not be deleted from storage and stay for the next run.` : "",
          r.backlog > 0 ? `${r.backlog} more are due and will be taken tonight.` : "",
        ]
          .filter(Boolean)
          .join(" "),
  ),

  "integrity/retention/run": fmt<{
    retentionDays: number;
    signalsDeleted: number;
    draftsDeleted: number;
    telemetryDeleted: number;
    xapiDeleted: number;
    scansDeleted: number;
    skipped?: "DISABLED" | "NO_DB";
  }>((r) => {
    if (r.skipped === "DISABLED")
      return "Retention is switched off for this school, so nothing was deleted. Set a retention window first.";
    if (r.skipped === "NO_DB") return "The purge could not run — the platform is not configured for it. Report this.";
    const n = r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted + r.xapiDeleted + r.scansDeleted;
    return n === 0
      ? `Nothing was older than ${r.retentionDays} days — there was nothing to delete.`
      : `Deleted ${n.toLocaleString()} ${plural(n, "record")} older than ${r.retentionDays} days.`;
  }),

  "hostels/exeats/overdue/run": fmt<{ scanned: number; alerted: number; failed: number }>((r) =>
    r.scanned === 0
      ? "No boarder is out past their return time."
      : [
          `Checked ${r.scanned} ${plural(r.scanned, "exeat")}; alerted on ${r.alerted}.`,
          // REPORT WHAT IT DID NOT DO — this sweep used to mark every overdue
          // boarder handled, including the ones it could tell nobody about.
          r.failed > 0 ? `${r.failed} could not be alerted on and will be retried — chase those by hand.` : "",
        ]
          .filter(Boolean)
          .join(" "),
  ),

  "admin/sis/nudge/run": fmt<{ nudged: number; scanned: number }>((r) =>
    r.scanned === 0
      ? "Every pupil record has what it needs."
      : `Checked ${r.scanned} ${plural(r.scanned, "record")}; asked ${r.nudged} ${plural(r.nudged, "family", "families")} to fill in what is missing.`,
  ),

  "attendance/rollup/refresh": fmt<{ refreshed: string[]; skipped: number }>((r) =>
    r.refreshed.length === 0
      ? r.skipped > 0
        ? `Nothing to rebuild — ${r.skipped} ${plural(r.skipped, "term is", "terms are")} already up to date.`
        : "No ended term needs rebuilding."
      : `Rebuilt ${r.refreshed.length} ${plural(r.refreshed.length, "term")}${
          r.skipped > 0 ? `; ${r.skipped} were already up to date.` : "."
        }`,
  ),
};

export function SweepButton({
  path,
  label,
  help,
  variant = "outline",
}: {
  /** The API path, without the `/api/sms/` prefix. Also the key into DESCRIBE. */
  path: keyof typeof DESCRIBE;
  label: string;
  /** What one press does, in the reader's own terms. */
  help: string;
  variant?: "outline" | "default";
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/${path}`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      // The server's own words. A sweep refused for a reason the presser can act
      // on ("no privileged database") must not read as "Failed."
      setMsg(await readApiError(res));
      return;
    }
    setMsg(DESCRIBE[path]((await res.json()) as unknown));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant={variant} className="h-8" disabled={busy} onClick={run}>
        {busy ? "Running…" : label}
      </Button>
      <span className="text-xs text-muted-foreground">{help}</span>
      {msg && <p className="w-full text-xs text-foreground">{msg}</p>}
    </div>
  );
}
