"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const TYPES = ["REPORT_CARD", "RECEIPT", "CERTIFICATE", "TRANSCRIPT", "OTHER"] as const;
interface Student { id: string; name: string }

export function DocumentUpload({ students }: { students: Student[] }) {
  const router = useRouter();
  const [studentId, setStudentId] = React.useState(students[0]?.id ?? "");
  const [type, setType] = React.useState<(typeof TYPES)[number]>("REPORT_CARD");
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;
    setBusy(true); setMsg(null);
    // 1) create metadata + get a presigned upload URL
    const createRes = await fetch("/api/sms/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: studentId || null, type, title, contentType: "application/pdf" }),
    });
    if (!createRes.ok) { setBusy(false); setMsg(`Create failed (${createRes.status}).`); return; }
    const { document } = (await createRes.json()) as { document: { id: string } };
    // 2) the browser would PUT the file to upload.url here (object storage stub).
    // 3) confirm the upload completed.
    const confirmRes = await fetch(`/api/sms/documents/${document.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (confirmRes.ok) { setTitle(""); setMsg("Document added; guardians notified for report cards/certificates."); router.refresh(); }
    else setMsg(`Confirm failed (${confirmRes.status}).`);
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
          <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add document"}</Button>
          {msg && <p className="w-full text-sm text-muted-foreground">{msg}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
