"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MEETING_PROVIDERS, MEETING_PROVIDER_LABELS } from "@sms/types";
import { readApiError } from "@/lib/api-error";

export function EventForm() {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [audience, setAudience] = React.useState<"ALL" | "STAFF">("ALL");
  // Optional video meeting — this is what makes a STAFF-audience event usable as
  // an actual staff meeting. The server validates the URL's host and only
  // releases it inside the join window.
  const [provider, setProvider] = React.useState("");
  const [joinUrl, setJoinUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !startsAt) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/sms/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        startsAt: new Date(startsAt).toISOString(),
        audience,
        provider: provider || undefined,
        joinUrl: provider ? joinUrl : undefined,
      }),
    });
    setBusy(false);
    if (res.ok) { setTitle(""); setStartsAt(""); setProvider(""); setJoinUrl(""); router.refresh(); }
    else setErr(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Add an event</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5"><Label htmlFor="ev-title">Title</Label><Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mid-term break" /></div>
          <div className="space-y-1.5"><Label htmlFor="ev-when">When</Label><Input id="ev-when" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-aud">Audience</Label>
            <select id="ev-aud" value={audience} onChange={(e) => setAudience(e.target.value as "ALL" | "STAFF")} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="ALL">Everyone</option>
              <option value="STAFF">Staff only</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-prov">Meeting</Label>
            <select id="ev-prov" value={provider} onChange={(e) => setProvider(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">In person</option>
              {MEETING_PROVIDERS.map((mp) => <option key={mp} value={mp}>{MEETING_PROVIDER_LABELS[mp]}</option>)}
            </select>
          </div>
          {provider && (
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ev-url">Join link</Label>
              <Input id="ev-url" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} placeholder="https://teams.microsoft.com/l/meetup-join/…" required />
            </div>
          )}
          <Button type="submit" disabled={busy}>Add</Button>
          {err && <p className="w-full text-sm text-destructive">{err}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
