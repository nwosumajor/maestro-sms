"use client";

// Parent onboarding — single create + bulk CSV upload (maker-checker). New
// parent accounts get a one-time password (shown ONCE) and are linked to their
// children, referenced by admission number / student email. Mirrors SisImport.

import type { ParentImportBatchDto, IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Batch = Serialized<ParentImportBatchDto>;
type Student = Serialized<IdNameDto>;
type Cred = { name: string; email: string; tempPassword: string };

const COLS = ["name", "email", "phone", "studentAdmissionNumbers", "studentEmails", "relationship"] as const;

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

function credsCsv(creds: Cred[]): string {
  const cell = (v: string) => {
    let t = v;
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // formula-injection guard
    return `"${t.replace(/"/g, '""')}"`;
  };
  return ["name,email,temporaryPassword", ...creds.map((c) => [c.name, c.email, c.tempPassword].map(cell).join(","))].join("\n");
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export function ParentOnboard({ batches, students, currentUserId }: { batches: Batch[]; students: Student[]; currentUserId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [creds, setCreds] = React.useState<Cred[] | null>(null);

  // --- single ---
  const [single, setSingle] = React.useState({ name: "", email: "", phone: "", relationship: "" });
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const togglePick = (id: string) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const createSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!single.name.trim() || !single.email.trim()) { setMsg("Name and email are required."); return; }
    setBusy(true); setMsg(null); setCreds(null);
    const res = await sendSms("POST", "admin/parents", {
      name: single.name.trim(), email: single.email.trim(), phone: single.phone.trim() || null,
      studentIds: [...picked], relationship: single.relationship.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      const r = res.data as { created: boolean; tempPassword: string | null; name: string; email: string; linkedStudentIds: string[] };
      if (r.created && r.tempPassword) setCreds([{ name: r.name, email: r.email, tempPassword: r.tempPassword }]);
      setMsg(r.created
        ? `Created ${r.name} and linked ${r.linkedStudentIds.length} child(ren). Save the login below.`
        : `${r.name} already had an account — linked ${r.linkedStudentIds.length} child(ren).`);
      setSingle({ name: "", email: "", phone: "", relationship: "" }); setPicked(new Set());
      router.refresh();
    } else setMsg(res.error ?? "Request failed.");
  };

  // --- bulk ---
  const [csv, setCsv] = React.useState(`${COLS.join(",")}\nGrace Bassey,grace@example.com,08010000000,ADM-001;ADM-014,,Mother`);
  const downloadTemplate = async () => {
    const res = await fetch("/api/sms/admin/parents/import/template");
    if (!res.ok) { setMsg(`Template download failed (${res.status}).`); return; }
    download("parent-import-template.csv", await res.text());
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? "")); setMsg(`Loaded ${file.name} — review, then "Stage import".`); };
    reader.readAsText(file);
    e.target.value = "";
  };
  const stage = async (e: React.FormEvent) => {
    e.preventDefault();
    const rows = parseCsv(csv).filter((r) => r.name && r.email).map((r) => ({
      name: r.name, email: r.email, phone: r.phone || null,
      studentAdmissionNumbers: r.studentAdmissionNumbers || null,
      studentEmails: r.studentEmails || null,
      relationship: r.relationship || null,
    }));
    if (rows.length === 0) { setMsg("No valid rows (need at least name + email)."); return; }
    setBusy(true); setMsg(null);
    const res = await sendSms("POST", "admin/parents/import", { rows });
    setBusy(false);
    if (res.ok) {
      const b = res.data as Batch;
      setMsg(`Staged ${b.summary?.total ?? rows.length} rows (${b.summary?.newCount ?? "?"} new, ${b.summary?.duplicateCount ?? "?"} existing). Awaiting a different admin's approval.`);
      router.refresh();
    } else setMsg(res.error ?? `Failed to stage (${res.status}).`);
  };
  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(true); setMsg(null);
    const res = await sendSms("POST", `admin/parents/import/${id}/${action}`, {});
    setBusy(false);
    if (res.ok) {
      const b = res.data as Batch;
      if (action === "approve") {
        setCreds(b.credentials ?? null);
        setMsg(`Approved — created ${b.summary?.created ?? 0}, reused ${b.summary?.reused ?? 0}, linked ${b.summary?.linked ?? 0}${b.summary?.unmatchedStudents ? `, ${b.summary.unmatchedStudents} child ref(s) unmatched` : ""}.`);
      } else setMsg("Batch rejected.");
      router.refresh();
    } else setMsg(res.status === 403 ? "A different admin (not the uploader) must approve." : res.error ?? "Request failed.");
  };

  const pending = batches.filter((b) => b.status === "PENDING");

  return (
    <div className="space-y-4">
      {/* Single */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add one parent</CardTitle>
          <CardDescription>Creates a parent account with a one-time password and links them to their children.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={createSingle} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5"><Label htmlFor="p-name">Full name</Label><Input id="p-name" value={single.name} onChange={(e) => setSingle({ ...single, name: e.target.value })} required /></div>
              <div className="space-y-1.5"><Label htmlFor="p-email">Email</Label><Input id="p-email" type="email" value={single.email} onChange={(e) => setSingle({ ...single, email: e.target.value })} required /></div>
              <div className="space-y-1.5"><Label htmlFor="p-phone">Phone</Label><Input id="p-phone" value={single.phone} onChange={(e) => setSingle({ ...single, phone: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="p-rel">Relationship</Label><Input id="p-rel" value={single.relationship} onChange={(e) => setSingle({ ...single, relationship: e.target.value })} placeholder="Mother / Father / Guardian" /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Link children ({picked.size} selected)</Label>
              {students.length === 0 ? (
                <p className="text-xs text-muted-foreground">No students to link yet.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2">
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {students.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={picked.has(s.id)} onChange={() => togglePick(s.id)} className="accent-[hsl(var(--primary))]" />
                        <span className="truncate">{s.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Create parent"}</Button>
          </form>
        </CardContent>
      </Card>

      {/* One-time credentials */}
      {creds && creds.length > 0 && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">Parent sign-in slips — save these NOW</CardTitle>
            <CardDescription>Each new parent got a unique temporary password, shown ONLY once. They must change it at first sign-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Button size="sm" onClick={() => download("parent-login-slips.csv", credsCsv(creds))}>Download login slips (CSV)</Button>
              <Button size="sm" variant="ghost" onClick={() => setCreds(null)}>Dismiss</Button>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Name</th><th className="px-2 py-1 font-medium">Email</th><th className="px-2 py-1 font-medium">Temporary password</th>
                </tr></thead>
                <tbody>
                  {creds.map((c) => (
                    <tr key={c.email} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-1">{c.name}</td><td className="px-2 py-1">{c.email}</td><td className="px-2 py-1 font-mono">{c.tempPassword}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bulk */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bulk upload parents</CardTitle>
          <CardDescription>
            Download the template, list children by admission number (or email), semicolon-separated. Nothing is created
            until a <strong>different</strong> admin approves (maker-checker).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={downloadTemplate}>Download CSV template</Button>
            <Label htmlFor="parent-file" className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-card px-3 text-xs font-medium hover:bg-accent">Upload filled template (.csv)</Label>
            <input id="parent-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          </div>
          <form onSubmit={stage} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="parent-csv">CSV (header row required)</Label>
              <Textarea id="parent-csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="font-mono text-xs" />
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Staging…" : "Stage import"}</Button>
          </form>
        </CardContent>
      </Card>

      {/* Batches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import batches ({pending.length} pending)</CardTitle>
          <CardDescription>You can&apos;t approve a batch you uploaded yourself.</CardDescription>
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
                    <Badge variant={b.status === "APPROVED" ? "secondary" : b.status === "REJECTED" ? "destructive" : "outline"}>{b.status.toLowerCase()}</Badge>
                    {mine && <span className="ml-2 text-xs text-muted-foreground">(uploaded by you)</span>}
                  </p>
                  {b.summary && (
                    <p className="text-xs text-muted-foreground">
                      {b.status === "APPROVED"
                        ? `created ${b.summary.created ?? 0}, reused ${b.summary.reused ?? 0}, linked ${b.summary.linked ?? 0}`
                        : `${b.summary.newCount} new, ${b.summary.duplicateCount} existing`}
                    </p>
                  )}
                </div>
                {b.status === "PENDING" && (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7" disabled={busy || mine} onClick={() => decide(b.id, "approve")}>Approve</Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => decide(b.id, "reject")}>Reject</Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}
    </div>
  );
}
