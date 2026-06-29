"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — mirrors the server cap

/**
 * Student file-answer uploader (only rendered when the teacher enabled file
 * upload for the assessment). Presign → PUT to storage → confirm, mirroring the
 * Document Vault / LMS material flow. Disabled once the submission is submitted.
 */
export function SubmissionFileUpload({
  apiBaseUrl,
  assessmentId,
  submissionId,
  initialFileName,
  initialUploaded,
  disabled,
}: {
  apiBaseUrl: string;
  assessmentId: string;
  submissionId: string;
  initialFileName: string | null;
  initialUploaded: boolean;
  disabled: boolean;
}) {
  const base = `${apiBaseUrl.replace(/\/$/, "")}/assessments/${assessmentId}/submissions/${submissionId}`;
  const [fileName, setFileName] = React.useState(initialFileName);
  const [uploaded, setUploaded] = React.useState(initialUploaded);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side pre-checks for UX; the server re-validates type + size.
    if (!ALLOWED_TYPES.includes(file.type)) {
      setMsg("Unsupported file type. Allowed: PDF, image, text, or Word document.");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    if (file.size > MAX_BYTES) {
      setMsg(`File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // 1. presign
      const pres = await fetch(`${base}/file/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }),
      });
      if (!pres.ok) throw new Error(pres.status === 400 ? "File upload is not enabled or the file was rejected." : `Presign failed (${pres.status}).`);
      const { url } = (await pres.json()) as { url: string };
      // 2. PUT bytes straight to storage
      const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
      // 3. confirm
      const conf = await fetch(`${base}/file/confirm`, { method: "POST" });
      if (!conf.ok) throw new Error(`Confirm failed (${conf.status}).`);
      setFileName(file.name);
      setUploaded(true);
      setMsg("File attached.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Upload error.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-sm font-medium">Attach a file answer</p>
      <p className="text-xs text-muted-foreground">
        {uploaded && fileName ? `Attached: ${fileName}` : "Upload your worked solution (PDF, image, doc)."}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input ref={inputRef} type="file" className="hidden" onChange={onPick} disabled={disabled || busy} />
        <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
          {busy ? "Uploading…" : uploaded ? "Replace file" : "Choose file"}
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
