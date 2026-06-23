"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export function ReportCardButton({ studentId }: { studentId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const generate = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/reportcards/${studentId}/generate`, { method: "POST" });
    setBusy(false);
    if (!res.ok) { setMsg(`Failed (${res.status}).`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-card-${studentId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Report card generated.");
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
