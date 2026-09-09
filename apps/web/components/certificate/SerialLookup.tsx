"use client";

// =============================================================================
// "Authenticity may be verified with the issuing school by quoting the serial
// number" — the sentence printed on every certificate this product produces.
// =============================================================================
// Nothing in the product accepted a serial. The only way to see one was the
// per-pupil history, which needs the pupil's id — the one thing somebody
// checking a document they have been handed does not have. So a school
// telephoned by an employer holding a testimonial, or a registrar sent a
// scanned certificate, could not answer the question its own paper told them to
// ask.
//
// It answers about THIS school only: a serial from another school reads exactly
// like one that was never issued, so verification cannot be used to discover
// what another school has issued.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { readApiError } from "@/lib/api-error";
import { useFormat } from "@/components/shell/RegionProvider";

type Verified = {
  serial: string;
  type: string;
  title: string | null;
  body: string | null;
  subjectName: string;
  subjectRole: string;
  issuedOn: string;
  issuedByName: string | null;
};

export function SerialLookup() {
  const { shortDate } = useFormat();
  const [serial, setSerial] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [found, setFound] = React.useState<Verified | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const look = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = serial.trim();
    if (!q) return;
    setBusy(true);
    setMsg(null);
    setFound(null);
    const res = await fetch(`/api/sms/certificates/verify/${encodeURIComponent(q)}`);
    setBusy(false);
    if (!res.ok) {
      // The server's reason, with this hint only when it gives none. A 404 here
      // is the real answer to the question — not an error to apologise for.
      setMsg(await readApiError(res, "No certificate with that serial was issued by this school."));
      return;
    }
    setFound((await res.json()) as Verified);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Check a certificate</CardTitle>
        <CardDescription>
          Someone has handed you a certificate or been sent one. Type the serial printed along its foot to see what
          this school actually issued under it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={look} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="serial-lookup">Serial</Label>
            <Input
              id="serial-lookup"
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder="CERT-XXXXXXXX-XXXXXXXX"
              className="w-72 font-mono"
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !serial.trim()}>
            {busy ? "Checking…" : "Check"}
          </Button>
        </form>

        {msg && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Not on this school&rsquo;s register</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{msg}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              That means this school has no record of issuing it. A certificate from another school will read the
              same way here — check the name on the document and ask the school that issued it.
            </p>
          </div>
        )}

        {found && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Issued by this school</Badge>
              <span className="font-mono text-xs text-muted-foreground">{found.serial}</span>
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Issued to</dt>
                <dd className="font-medium">
                  {found.subjectName} <span className="text-xs text-muted-foreground">({found.subjectRole})</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Issued on</dt>
                <dd className="font-medium">{shortDate(found.issuedOn)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Document</dt>
                <dd className="font-medium">{found.title || found.type.replace(/_/g, " ").toLowerCase()}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Issued by</dt>
                <dd className="font-medium">{found.issuedByName ?? "—"}</dd>
              </div>
            </dl>
            {found.body && <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">{found.body}</p>}
            {/* Comparison a person can make, which is the whole point: a digest
                cannot be recomputed by eye, and the reader is holding the paper. */}
            <p className="mt-2 text-xs text-muted-foreground">
              Compare this against the document in front of you. A serial that matches but a name, award or date that
              does not means the paper has been altered.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
