"use client";

// =============================================================================
// CareersBoard — public vacancy list + application form (no auth)
// =============================================================================
// Posts through the public BFF proxy (/api/public/careers/:slug/apply) to the
// rate-limited @Public API intake. One application per email per vacancy.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Job = { id: string; title: string; department: string | null; description: string | null; openings: number };

export function CareersBoard({ slug, jobs }: { slug: string; jobs: Job[] }) {
  const [applyTo, setApplyTo] = React.useState<Job | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [note, setNote] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (!applyTo || !name.trim() || !email.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/public/careers/${slug}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requisitionId: applyTo.id,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        note: note.trim() || undefined,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg(`Application received for “${applyTo.title}”. The school's HR team will be in touch.`);
      setApplyTo(null);
      setName("");
      setEmail("");
      setPhone("");
      setNote("");
    } else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(j?.message ?? `Something went wrong (${res.status}).`);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {jobs.length === 0 && <p className="text-sm text-muted-foreground">No open positions right now — check back soon.</p>}

      {jobs.map((j) => (
        <Card key={j.id}>
          <CardHeader>
            <CardTitle className="text-base">{j.title}</CardTitle>
            <CardDescription>
              {j.department && <Badge variant="outline" className="mr-2">{j.department}</Badge>}
              {j.openings > 1 ? `${j.openings} openings` : "1 opening"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {j.description && <p className="whitespace-pre-wrap text-sm">{j.description}</p>}
            {applyTo?.id !== j.id ? (
              <Button size="sm" onClick={() => { setApplyTo(j); setMsg(null); setErr(null); }}>
                Apply for this role
              </Button>
            ) : (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Full name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phone (optional)</Label>
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Cover note (optional)</Label>
                  <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={submit} disabled={busy || !name.trim() || !email.trim()}>
                    Submit application
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setApplyTo(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}
