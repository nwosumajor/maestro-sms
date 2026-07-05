"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { readApiError } from "@/lib/api-error";

export function ImportStudents({ classes }: { classes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [csv, setCsv] = React.useState("Ada Obi, ada@demo.school\nBolu Eze, bolu@demo.school");
  const [classId, setClassId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const rows = csv.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, email] = l.split(",").map((s) => s.trim());
      return { name, email, classId: classId || null };
    }).filter((r) => r.name && r.email);
    if (rows.length === 0) { setMsg("No valid rows."); return; }
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/admin/import/students", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }),
    });
    setBusy(false);
    if (res.ok) {
      const r = (await res.json()) as { created: number; skipped: number; errors: string[] };
      setMsg(`Imported ${r.created}, skipped ${r.skipped}${r.errors.length ? `, ${r.errors.length} errors` : ""}.`);
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="imp-csv">Students (one per line: <code>Name, email</code>)</Label>
        <Textarea id="imp-csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} className="font-mono text-xs" />
      </div>
      <div className="flex items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="imp-class">Enroll into class (optional)</Label>
          <select id="imp-class" value={classId} onChange={(e) => setClassId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
            <option value="">— none —</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <Button type="submit" disabled={busy}>{busy ? "Importing…" : "Import"}</Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>
    </form>
  );
}
