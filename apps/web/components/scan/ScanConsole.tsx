"use client";
import * as React from "react";
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

// A handheld barcode/QR scanner behaves like a keyboard: it "types" the code then
// sends Enter. So we keep an always-focused input and act on submit. The purpose
// selector decides whether the scan RECORDS an action (POST) or just resolves
// identity ("Look up only" -> GET).
export function ScanConsole() {
  const [code, setCode] = React.useState("");
  const [purpose, setPurpose] = React.useState<string>("CHECK_IN");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ResolvedResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, [result, error]);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (purpose === "LOOKUP") {
        const res = await fetch(`/api/sms/members/scan/${encodeURIComponent(c)}`, { cache: "no-store" });
        if (res.ok) setResult({ kind: "lookup", member: (await res.json()) as Serialized<MemberScanDto> });
        else setError(res.status === 404 ? "No member with that code in this school." : `Lookup failed (${res.status}).`);
      } else {
        const res = await sendSms<Serialized<ScanRecordResultDto>>("POST", `members/scan/${encodeURIComponent(c)}`, {
          purpose,
        });
        if (res.ok && res.data) setResult({ kind: "record", data: res.data });
        else setError(res.status === 404 ? "No member with that code in this school." : (res.error ?? "Scan failed."));
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
      setCode("");
    }
  };

  const member = result?.kind === "lookup" ? result.member : result?.kind === "record" ? result.data.member : null;
  const record = result?.kind === "record" ? result.data : null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scan a card</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={go} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="scan-purpose">Action</Label>
              <select
                id="scan-purpose"
                value={purpose}
                onChange={(ev) => setPurpose(ev.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="LOOKUP">Look up only (no action)</option>
                {SCAN_PURPOSES.map((pp) => (
                  <option key={pp} value={pp}>
                    {SCAN_PURPOSE_LABELS[pp]}
                  </option>
                ))}
              </select>
            </div>
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
                {busy ? "…" : purpose === "LOOKUP" ? "Look up" : "Record"}
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            A handheld scanner types the code and submits automatically. Only members of your school resolve.
            &ldquo;Check in&rdquo; marks a student present in today&apos;s register.
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
              {record && (
                <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  <span className="font-medium">
                    Recorded: {SCAN_PURPOSE_LABELS[record.purpose as keyof typeof SCAN_PURPOSE_LABELS] ?? record.purpose}
                  </span>
                  {record.attendanceMarkedClass && <div>Marked present in {record.attendanceMarkedClass}.</div>}
                  {record.attendanceNote && <div className="text-emerald-700/80">{record.attendanceNote}</div>}
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
