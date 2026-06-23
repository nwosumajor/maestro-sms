"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function EventForm() {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [audience, setAudience] = React.useState<"ALL" | "STAFF">("ALL");
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !startsAt) return;
    setBusy(true);
    const res = await fetch("/api/sms/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, startsAt: new Date(startsAt).toISOString(), audience }),
    });
    setBusy(false);
    if (res.ok) { setTitle(""); setStartsAt(""); router.refresh(); }
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
          <Button type="submit" disabled={busy}>Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}
