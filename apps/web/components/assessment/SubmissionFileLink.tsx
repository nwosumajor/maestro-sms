"use client";

import * as React from "react";

/** Reviewer download of a student's file answer: fetch the presigned URL then open it. */
export function SubmissionFileLink({
  assessmentId,
  submissionId,
  fileName,
}: {
  assessmentId: string;
  submissionId: string;
  fileName: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true);
    const res = await fetch(`/api/sms/assessments/${assessmentId}/submissions/${submissionId}/file`);
    setBusy(false);
    if (res.ok) {
      const { url } = (await res.json()) as { url: string };
      window.open(url, "_blank", "noopener");
    }
  };
  return (
    <button onClick={open} disabled={busy} className="text-primary hover:underline disabled:opacity-50">
      {busy ? "…" : `Download${fileName ? ` (${fileName})` : " file"}`}
    </button>
  );
}
