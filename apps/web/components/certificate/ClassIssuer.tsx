"use client";

import * as React from "react";
import { postSms } from "@/components/game/play-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type IdName = { id: string; name: string };
type Result = {
  issued: number;
  skipped: number;
  students: Array<{ id: string; name: string; alreadyIssued: boolean }>;
};

const TYPES = [
  { value: "COMPLETION", label: "Completion" },
  { value: "PARTICIPATION", label: "Participation" },
  { value: "MERIT", label: "Merit" },
  { value: "ID_CARD", label: "ID card" },
];

/**
 * Issue a certificate to a whole class.
 *
 * Issuing was strictly one pupil at a time, so a completion run for a leaving year
 * group meant picking 31 names by hand and keeping track of which were done.
 *
 * The button REGISTERS the issuance; the PDFs are still produced one pupil at a time
 * by the single-issue endpoint, which each row links to. There is no zip dependency
 * in this project, and a response carrying thirty-odd generated PDFs is a timeout
 * waiting to happen — so this removes the bookkeeping, not the printing, and says so.
 */
export function ClassIssuer({ classes }: { classes: IdName[] }) {
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [type, setType] = React.useState("COMPLETION");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Result | null>(null);
  const [downloading, setDownloading] = React.useState<string | null>(null);

  const download = async (s: { id: string; name: string }) => {
    setDownloading(s.id);
    const res = await fetch("/api/sms/certificates/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subjectId: s.id }),
    });
    setDownloading(null);
    if (!res.ok) {
      setMsg("Could not generate that certificate.");
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type.toLowerCase()}-${s.name.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (classes.length === 0) return null;

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const res = await postSms<Result>(`certificates/issue-class`, { classId, type });
    setBusy(false);
    if (res.ok && res.data) {
      setResult(res.data);
      setMsg(
        res.data.issued === 0
          ? "Everyone in this class already holds that certificate — nothing was issued."
          : `Issued ${res.data.issued}${res.data.skipped > 0 ? `, skipped ${res.data.skipped} already issued` : ""}.`,
      );
    } else setMsg(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Issue for a whole class</CardTitle>
        <CardDescription>
          Registers the certificate for every pupil who does not already hold that type. Safe to press twice — an existing
          certificate is never reissued. Download each pupil&apos;s PDF from the list below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select className="rounded-md border bg-background p-1.5 text-sm" value={classId} onChange={(e) => setClassId(e.target.value)}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select className="rounded-md border bg-background p-1.5 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !classId} onClick={run}>
            {busy ? "Issuing…" : "Issue for class"}
          </Button>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        {result && (
          <div className="max-h-64 overflow-y-auto rounded-md border">
            <table className="w-full text-xs">
              <tbody>
                {result.students.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5">{s.name}</td>
                    <td className="px-3 py-1.5">
                      {/* Says who was ALREADY done rather than hiding them — that is the
                          bookkeeping this replaces. */}
                      {s.alreadyIssued ? <Badge variant="outline">already issued</Badge> : <Badge variant="secondary">issued now</Badge>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {/* The issue endpoint is a POST returning bytes, so this fetches
                          and saves the blob — a plain href would 404 on method. */}
                      <button
                        className="text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                        disabled={downloading === s.id}
                        onClick={() => void download(s)}
                      >
                        {downloading === s.id ? "…" : "PDF"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
