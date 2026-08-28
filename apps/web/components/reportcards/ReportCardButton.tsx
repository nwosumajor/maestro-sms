"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { downloadReportCard } from "@/lib/report-card-download";

export function ReportCardButton({ studentId }: { studentId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const generate = async () => {
    setBusy(true); setMsg(null);
    const r = await downloadReportCard(studentId);
    setBusy(false);
    setMsg(r.ok ? `Saved ${r.filename}` : r.error);
  };

  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" onClick={generate} disabled={busy}>
        {busy ? "Generating…" : "Generate report card (PDF)"}
      </Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
