"use client";

import * as React from "react";
import { readApiError } from "@/lib/api-error";

/** Downloads the whole-SESSION cumulative report PDF (every term + session
 *  averages). Same server-side scoping as the on-screen report. */
export function SessionReportButton({
  studentId,
  sessionId,
  sessionName,
}: {
  studentId: string;
  sessionId: string;
  sessionName: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/term-results/report/${studentId}/${sessionId}/session-pdf`);
    if (!res.ok) {
      setBusy(false);
      setErr(await readApiError(res));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-report-${sessionName.replace(/\s+/g, "-").toLowerCase()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setBusy(false);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
      >
        {busy ? "Preparing…" : "Download session report (all terms)"}
      </button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}
