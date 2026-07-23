"use client";
import * as React from "react";
import type { Serialized, MemberScanDto } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

// A handheld barcode/QR scanner behaves like a keyboard: it "types" the code
// then sends Enter. So we keep an always-focused input and look up on submit.
export function ScanConsole() {
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Serialized<MemberScanDto> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, [result, error]);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    setResult(null);
    // GET via the BFF; the code is opaque (uniqueId) and URL-safe.
    try {
      const res = await fetch(`/api/sms/members/scan/${encodeURIComponent(c)}`, { cache: "no-store" });
      setCode("");
      if (res.ok) {
        setResult((await res.json()) as Serialized<MemberScanDto>);
      } else {
        setError(res.status === 404 ? "No member with that code in this school." : `Lookup failed (${res.status}).`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scan or enter a card code</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={lookup} className="flex items-end gap-2">
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
              {busy ? "…" : "Look up"}
            </Button>
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
          {!error && !result && <p className="text-sm text-muted-foreground">Waiting for a scan…</p>}
          {result && (
            <dl className="space-y-1.5 text-sm">
              <Row k="Name" v={result.name} />
              <Row k="Role" v={result.role} />
              {result.admissionNumber && <Row k="Admission no." v={result.admissionNumber} mono />}
              {result.className && <Row k="Class" v={result.className} />}
              <Row k="Card code" v={result.uniqueId} mono />
              <div className="flex items-center gap-2 pt-1">
                <dt className="w-28 shrink-0 text-muted-foreground">Status</dt>
                <dd
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    result.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                  }`}
                >
                  {result.status}
                </dd>
              </div>
            </dl>
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
