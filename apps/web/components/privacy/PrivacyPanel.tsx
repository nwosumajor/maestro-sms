"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

export function PrivacyPanel({ studentId }: { studentId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);

  const exportData = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/privacy/export/${studentId}`);
    setBusy(false);
    if (!res.ok) { setMsg(`Export failed (${res.status}).`); return; }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `student-${studentId}-data.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Data exported.");
  };

  const requestErasure = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason) return;
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/privacy/erasure", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, reason }),
    });
    setBusy(false);
    if (res.ok) { setReason(""); setMsg("Erasure request submitted for review."); }
    else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Data &amp; privacy (NDPR)</CardTitle>
        <CardDescription>Export this student's data, or request its erasure (reviewed by the school).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" onClick={exportData} disabled={busy}>Export data (JSON)</Button>
        <form onSubmit={requestErasure} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="erase-reason">Request erasure — reason</Label>
            <Input id="erase-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. left the school" />
          </div>
          <Button type="submit" variant="ghost" disabled={busy || !reason}>Request erasure</Button>
        </form>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
