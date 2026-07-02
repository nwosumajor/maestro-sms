"use client";

import type { StudentImportBatchDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Batch = Serialized<StudentImportBatchDto>;

const COLS = ["name", "email", "admissionNumber", "dateOfBirth", "gender", "phone", "address", "classId"] as const;

/** Parse a CSV string (header row + data rows) into typed SIS rows. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { if (cells[i]) row[h] = cells[i]; });
    return row;
  });
}

export function SisImport({ batches, currentUserId }: { batches: Batch[]; currentUserId: string }) {
  const router = useRouter();
  const [csv, setCsv] = React.useState(`${COLS.join(",")}\nAda Lovelace,ada@example.com,ADM-001,2012-05-01,F,08000000000,12 Main St,`);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const downloadTemplate = async () => {
    const res = await fetch("/api/sms/admin/students/import/template");
    if (!res.ok) { setMsg(`Template download failed (${res.status}).`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sis-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  /** Load the filled-in template FILE straight into the CSV box (client-side
   *  read — the data still goes through the same staged, maker-checker path). */
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ""));
      setMsg(`Loaded ${file.name} — review below, then press "Stage import".`);
    };
    reader.onerror = () => setMsg("Could not read that file.");
    reader.readAsText(file);
    e.target.value = ""; // allow re-selecting the same file
  };

  const stage = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseCsv(csv);
    const rows = parsed
      .filter((r) => r.name && r.email)
      .map((r) => ({
        name: r.name,
        email: r.email,
        admissionNumber: r.admissionNumber || null,
        dateOfBirth: r.dateOfBirth || null,
        gender: r.gender || null,
        phone: r.phone || null,
        address: r.address || null,
        classId: r.classId || null,
      }));
    if (rows.length === 0) { setMsg("No valid rows (need at least name + email)."); return; }
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/admin/students/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }),
    });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      setMsg(`Staged ${b.summary?.total ?? rows.length} rows (${b.summary?.newCount ?? "?"} new, ${b.summary?.duplicateCount ?? "?"} duplicate). Awaiting approval by a different admin.`);
      router.refresh();
    } else setMsg(`Failed to stage (${res.status}).`);
  };

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/admin/students/import/${id}/${action}`, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      setMsg(action === "approve" ? `Approved — created ${b.summary?.created ?? 0}, skipped ${b.summary?.skipped ?? 0}.` : "Batch rejected.");
      router.refresh();
    } else setMsg(res.status === 403 ? "A different admin (not the uploader) must approve." : `Failed (${res.status}).`);
  };

  const pending = batches.filter((b) => b.status === "PENDING");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stage a bulk SIS upload</CardTitle>
          <CardDescription>
            Download the template, fill it in, then <strong>upload the file</strong> (or paste the CSV) and
            stage it. Nothing is created until a <strong>different</strong> admin approves the batch
            (maker-checker).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={downloadTemplate}>Download CSV template</Button>
            <Label
              htmlFor="sis-file"
              className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-card px-3 text-xs font-medium hover:bg-accent"
            >
              Upload filled template (.csv)
            </Label>
            <input id="sis-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          </div>
          <form onSubmit={stage} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sis-csv">CSV (header row required)</Label>
              <Textarea id="sis-csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="font-mono text-xs" />
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Staging…" : "Stage import"}</Button>
          </form>
          {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import batches ({pending.length} pending)</CardTitle>
          <CardDescription>Review staged batches. You can&apos;t approve a batch you uploaded yourself.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {batches.length === 0 && <p className="text-sm text-muted-foreground">No batches yet.</p>}
          {batches.map((b) => {
            const mine = b.uploadedById === currentUserId;
            return (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">
                    {b.rowCount} rows{" "}
                    <Badge variant={b.status === "APPROVED" ? "secondary" : b.status === "REJECTED" ? "destructive" : "outline"}>
                      {b.status.toLowerCase()}
                    </Badge>
                    {mine && <span className="ml-2 text-xs text-muted-foreground">(uploaded by you)</span>}
                  </p>
                  {b.summary && (
                    <p className="text-xs text-muted-foreground">
                      {b.status === "APPROVED"
                        ? `created ${b.summary.created ?? 0}, skipped ${b.summary.skipped ?? 0}`
                        : `${b.summary.newCount} new, ${b.summary.duplicateCount} duplicate`}
                    </p>
                  )}
                </div>
                {b.status === "PENDING" && (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7" disabled={busy || mine} onClick={() => decide(b.id, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => decide(b.id, "reject")}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
