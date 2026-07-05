"use client";

// super_admin NDPR bulk export of a school's student data. Step-up gated; the
// server runs it under the target school's RLS context and audits it. The result
// downloads as a JSON bundle the operator can hand to the requesting school.

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";

export function StudentDataExport({ schoolId, schoolName }: { schoolId: string; schoolName: string }) {
  const [includeMedical, setIncludeMedical] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("POST", `operator/tenants/${schoolId}/students/export`, { includeMedical });
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: await readApiError(res) });
      return;
    }
    const bundle = (await res.json()) as { count: number };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `students-export-${schoolName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg({ ok: true, text: `Exported ${bundle.count} student record(s) — download started. This disclosure is audited.` });
  };

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">NDPR data export</p>
      <p className="text-xs text-muted-foreground">
        Download this school&apos;s student records (profiles, enrolments, attendance, invoices, documents) to fulfil a
        lawful request. Confirm the request&apos;s basis first — every export is audited.
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={includeMedical} onChange={(e) => setIncludeMedical(e.target.checked)} />
        Include medical records (sensitive — only when the request specifically covers them)
      </label>
      <Button size="sm" variant="outline" disabled={busy} onClick={run}>
        {busy ? "Exporting…" : "Export student data"}
      </Button>
      {msg && <p className={`text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</p>}
    </div>
  );
}
