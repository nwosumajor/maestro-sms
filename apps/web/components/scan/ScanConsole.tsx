"use client";
import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import type { Serialized, MemberScanDto, ScanRecordResultDto } from "@sms/types";
import { SCAN_PURPOSES, SCAN_PURPOSE_LABELS } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { sendSms } from "@/components/game/play-ui";

type ResolvedResult =
  | { kind: "lookup"; member: Serialized<MemberScanDto> }
  | { kind: "record"; data: Serialized<ScanRecordResultDto> };

/** One line of the desk's running log. Failures are entries too — a scan that
 *  did nothing must be as visible as one that worked. */
type LogEntry = {
  id: number;
  at: string;
  ok: boolean;
  who: string;
  what: string;
};

// A handheld barcode/QR scanner behaves like a keyboard: it "types" the code
// then sends Enter. So we keep an always-focused input and act on submit.
//
// THE THING THIS PAGE MUST NOT GET WRONG: a scan either just says WHO somebody
// is, or it WRITES something — a check-in marks a pupil present in today's
// register, under the scanner's name. Those are different acts and the desk
// used to blur them: one dropdown labelled "Action" whose first option was
// "no action", defaulting to CHECK_IN. Opening the page to see who a card
// belonged to marked that pupil present.
//
// So: two explicit modes, IDENTIFY first and default, and the pending act is
// stated where the operator is actually looking — next to the card, not in a
// dropdown they set once and forgot.
export function ScanConsole() {
  // Times follow the SCHOOL's clock, not the browser's.
  const { timeOfDay } = useFormat();
  const [mode, setMode] = React.useState<"identify" | "record">("identify");
  const [purpose, setPurpose] = React.useState<string>("CHECK_IN");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ResolvedResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, [result, error, mode, purpose]);

  const push = (ok: boolean, who: string, what: string) =>
    setLog((prev) =>
      [
        { id: (seq.current += 1), at: timeOfDay(new Date()), ok, who, what },
        ...prev,
      ].slice(0, 8),
    );

  const purposeLabel = SCAN_PURPOSE_LABELS[purpose as keyof typeof SCAN_PURPOSE_LABELS] ?? purpose;

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (mode === "identify") {
        const res = await fetch(`/api/sms/members/scan/${encodeURIComponent(c)}`, { cache: "no-store" });
        if (res.ok) {
          const member = (await res.json()) as Serialized<MemberScanDto>;
          setResult({ kind: "lookup", member });
          push(true, member.name, "Identified — nothing recorded");
        } else {
          const m = res.status === 404 ? "No member with that code in this school." : `Lookup failed (${res.status}).`;
          setError(m);
          push(false, c, m);
        }
      } else {
        const res = await sendSms<Serialized<ScanRecordResultDto>>("POST", `members/scan/${encodeURIComponent(c)}`, {
          purpose,
        });
        if (res.ok && res.data) {
          setResult({ kind: "record", data: res.data });
          push(
            true,
            res.data.member.name,
            res.data.attendanceMarkedClass
              ? `${purposeLabel} — marked present in ${res.data.attendanceMarkedClass}`
              : purposeLabel,
          );
        } else {
          const m = res.status === 404 ? "No member with that code in this school." : (res.error ?? "Scan failed.");
          setError(m);
          push(false, c, m);
        }
      }
    } catch {
      setError("Could not reach the server.");
      push(false, c, "Could not reach the server");
    } finally {
      setBusy(false);
      setCode("");
    }
  };

  const member = result?.kind === "lookup" ? result.member : result?.kind === "record" ? result.data.member : null;
  const record = result?.kind === "record" ? result.data : null;
  const recording = mode === "record";

  return (
    <div className="space-y-4">
      {/* WHAT THE NEXT SCAN WILL DO — stated once, prominently, in the operator's
          line of sight. At a gate desk you look at the card and the strip, never
          at a control you set five minutes ago. */}
      <div
        className={`rounded-md border px-4 py-3 text-sm ${
          recording
            ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
            : "border-border bg-muted/40 text-muted-foreground"
        }`}
        aria-live="polite"
      >
        <span className="font-medium">
          {recording ? `The next scan will RECORD: ${purposeLabel}` : "The next scan will only identify the card"}
        </span>
        {recording ? (
          <span className="block text-xs">
            {purpose === "CHECK_IN"
              ? "This marks the pupil present in today's register, under your name."
              : "This writes a movement record against the member."}
          </span>
        ) : (
          <span className="block text-xs">Nothing is written. Use this to check who a card belongs to.</span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scan a card</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={go} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Mode</Label>
                {/* Two buttons, not a dropdown with a "no action" option in it.
                    Identify is first and is the default: the safe act, and the
                    one somebody opening this page most often wants. */}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={recording ? "outline" : "default"}
                    onClick={() => setMode("identify")}
                  >
                    Identify only
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={recording ? "default" : "outline"}
                    onClick={() => setMode("record")}
                  >
                    Record an action
                  </Button>
                </div>
              </div>

              {recording && (
                <div className="space-y-1.5">
                  <Label htmlFor="scan-purpose">What to record</Label>
                  <select
                    id="scan-purpose"
                    value={purpose}
                    onChange={(ev) => setPurpose(ev.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {SCAN_PURPOSES.map((pp) => (
                      <option key={pp} value={pp}>
                        {SCAN_PURPOSE_LABELS[pp]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="scan-code">Card code</Label>
                  <Input
                    id="scan-code"
                    ref={inputRef}
                    value={code}
                    autoComplete="off"
                    placeholder="e.g. SMS-A3F2C1D90B4E"
                    onChange={(ev) => setCode(ev.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? "…" : recording ? "Record" : "Identify"}
                </Button>
              </div>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              A handheld scanner types the code and submits automatically. Only members of your school resolve.
            </p>
          </CardContent>
        </Card>

        <Card aria-live="polite">
          <CardHeader>
            <CardTitle className="text-base">Result</CardTitle>
          </CardHeader>
          <CardContent>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!error && !member && <p className="text-sm text-muted-foreground">Waiting for a scan…</p>}
            {member && (
              <div className="space-y-3">
                {/* A member who is not ACTIVE should stop the desk, not be a
                    small chip below the fold — that is the case a gate exists
                    for. */}
                {member.status !== "ACTIVE" && (
                  <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                    This member is {member.status.toLowerCase()} — check before letting them through.
                  </div>
                )}
                {record ? (
                  <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                    <span className="font-medium">
                      Recorded: {SCAN_PURPOSE_LABELS[record.purpose as keyof typeof SCAN_PURPOSE_LABELS] ?? record.purpose}
                    </span>
                    {record.attendanceMarkedClass && <div>Marked present in {record.attendanceMarkedClass}.</div>}
                    {record.attendanceNote && <div className="text-emerald-700/80 dark:text-emerald-300/80">{record.attendanceNote}</div>}
                  </div>
                ) : (
                  // Say it explicitly. An identify that looks like a record is
                  // how somebody believes a pupil was checked in when they were not.
                  <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                    Identified only — nothing was recorded.
                  </div>
                )}
                <dl className="space-y-1.5 text-sm">
                  <Row k="Name" v={member.name} />
                  <Row k="Role" v={member.role} />
                  {member.admissionNumber && <Row k="Admission no." v={member.admissionNumber} mono />}
                  {member.className && <Row k="Class" v={member.className} />}
                  <Row k="Card code" v={member.uniqueId} mono />
                  <div className="flex items-center gap-2 pt-1">
                    <dt className="w-28 shrink-0 text-muted-foreground">Status</dt>
                    <dd
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        member.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                      }`}
                    >
                      {member.status}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* THE RUNNING LOG. A desk scans people one after another and the result
          panel only ever shows the last one — so a scan that failed scrolled
          past unnoticed, and there was no way to answer "did that one go
          through?" without re-scanning and risking a second record. */}
      {log.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">This session</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {log.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{l.at}</span>
                  <span className={l.ok ? "font-medium" : "font-medium text-destructive"}>{l.who}</span>
                  <span className="text-xs text-muted-foreground">{l.what}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              The last {log.length} scan{log.length === 1 ? "" : "s"} on this screen. Clearing the page clears this list;
              the permanent record is in the audit log.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
      <dd className={mono ? "font-mono" : ""}>{v}</dd>
    </div>
  );
}
