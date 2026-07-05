"use client";

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

const TYPES = ["REPORT_CARD", "RECEIPT", "CERTIFICATE", "TRANSCRIPT", "OTHER"] as const;
type Student = Serialized<IdNameDto>;

// Read a File as a bare base64 string (strip the data: URL prefix).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function DocumentUpload({ students }: { students: Student[] }) {
  const router = useRouter();
  const [studentId, setStudentId] = React.useState(students[0]?.id ?? "");
  const [type, setType] = React.useState<(typeof TYPES)[number]>("REPORT_CARD");
  const [title, setTitle] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(false);
    if (!title.trim()) { setErr(true); setMsg("Enter a title."); return; }
    if (!file) { setErr(true); setMsg("Choose a file to upload."); return; }
    if (file.size > MAX_BYTES) { setErr(true); setMsg("File is larger than 10 MB."); return; }
    setBusy(true); setMsg("Uploading…");
    // 1) create metadata (PENDING)
    const createRes = await fetch("/api/sms/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: studentId || null, type, title: title.trim(),
        contentType: file.type || "application/octet-stream", sizeBytes: file.size,
      }),
    });
    if (!createRes.ok) { setBusy(false); setErr(true); setMsg(await readApiError(createRes)); return; }
    const { document } = (await createRes.json()) as { document: { id: string } };
    // 2) upload the actual bytes through the API (stored in object storage)
    const dataBase64 = await fileToBase64(file);
    const upRes = await fetch(`/api/sms/documents/${document.id}/upload-bytes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataBase64, contentType: file.type || "application/octet-stream" }),
    });
    setBusy(false);
    if (upRes.ok) {
      setErr(false);
      setTitle(""); setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setMsg("Uploaded ✓ — guardians are notified for report cards & certificates.");
      router.refresh();
    } else {
      setErr(true);
      setMsg(await readApiError(upRes));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a document</CardTitle>
        <CardDescription>Creates the record and a signed upload link (file bytes go to object storage).</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="d-student">Student</Label>
            <select id="d-student" value={studentId} onChange={(e) => setStudentId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-type">Type</Label>
            <select id="d-type" value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="d-title">Title</Label>
            <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Term 1 Report" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-file">File</Label>
            <input
              id="d-file"
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
            />
          </div>
          <Button type="submit" disabled={busy}>{busy ? "Uploading…" : "Upload document"}</Button>
          {msg && <p className={`w-full text-sm ${err ? "text-destructive" : "text-muted-foreground"}`}>{msg}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
