"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CreateAssessment({ classes }: { classes: { id: string; name: string }[] }) {
  const router = useRouter();
  const blank = { title: "", description: "", classId: "", fileUploadEnabled: false, integrityEnabled: false, timed: false, durationMinutes: 60, closesAt: "" };
  const [f, setF] = React.useState(blank);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/assessments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: f.title,
        description: f.description || undefined,
        classId: f.classId || undefined,
        fileUploadEnabled: f.fileUploadEnabled,
        integrityEnabled: f.integrityEnabled,
        timed: f.timed,
        durationMinutes: f.timed ? f.durationMinutes : undefined,
        closesAt: f.timed && f.closesAt ? new Date(f.closesAt).toISOString() : undefined,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setF(blank);
      router.refresh();
    } else setMsg(`Failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create an assignment</CardTitle>
        <CardDescription>
          Post an assessment for a class. Enable file upload to let students attach a worked solution
          (e.g. a PDF) instead of (or alongside) typing their answer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="as-title">Title</Label>
              <Input id="as-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="w-64" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="as-class">Class</Label>
              <select
                id="as-class"
                value={f.classId}
                onChange={(e) => setF({ ...f, classId: e.target.value })}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— none —</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="as-desc">Instructions</Label>
            <Textarea id="as-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.fileUploadEnabled} onChange={(e) => setF({ ...f, fileUploadEnabled: e.target.checked })} />
              Allow file upload submissions
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.integrityEnabled} onChange={(e) => setF({ ...f, integrityEnabled: e.target.checked })} />
              Enable integrity monitoring
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.timed} onChange={(e) => setF({ ...f, timed: e.target.checked })} />
              Timed exam
            </label>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Creating…" : "Create assignment"}</Button>
            {msg && <span className="text-sm text-destructive">{msg}</span>}
          </div>
          {f.timed && (
            <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
              <label className="text-sm">Duration (min)
                <input type="number" min={1} max={600} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} className="ml-2 h-8 w-20 rounded-md border border-input bg-background px-2" />
              </label>
              <label className="text-sm">Closes at (optional)
                <input type="datetime-local" value={f.closesAt} onChange={(e) => setF({ ...f, closesAt: e.target.value })} className="ml-2 h-8 rounded-md border border-input bg-background px-2" />
              </label>
              <span className="text-xs text-muted-foreground">Students get a countdown and auto-submit at the deadline.</span>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
