"use client";

import * as React from "react";
import { readApiError } from "@/lib/api-error";

/** Downloads one term's scoresheet PDF (student / parent / staff — server-scoped). */
export function TermScoresheetButton({
  studentId,
  sessionId,
  termId,
  termName,
}: {
  studentId: string;
  sessionId: string;
  termId: string;
  termName: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/term-results/report/${studentId}/${sessionId}/${termId}/pdf`);
    if (!res.ok) {
      setBusy(false);
      setErr(await readApiError(res));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scoresheet-${termName.replace(/\s+/g, "-").toLowerCase()}.pdf`;
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
        className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {busy ? "Preparing…" : "Download PDF"}
      </button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}
