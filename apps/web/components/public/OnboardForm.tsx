"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function OnboardForm() {
  const [f, setF] = React.useState({
    schoolName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    desiredSlug: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/public/onboarding-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setErr(`Something went wrong (${res.status}). Please check your details.`);
  };

  if (done) {
    return (
      <p className="text-sm">
        Thank you — your onboarding request has been received. Our team will review it and be in touch to set
        up your school.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="o-school">School name</Label>
        <Input id="o-school" value={f.schoolName} onChange={set("schoolName")} required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="o-name">Your name</Label>
          <Input id="o-name" value={f.contactName} onChange={set("contactName")} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-email">Email</Label>
          <Input id="o-email" type="email" value={f.contactEmail} onChange={set("contactEmail")} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-phone">Phone</Label>
          <Input id="o-phone" value={f.contactPhone} onChange={set("contactPhone")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-slug">Preferred web address <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="o-slug" value={f.desiredSlug} onChange={set("desiredSlug")} placeholder="st-marys" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="o-notes">Anything else?</Label>
        <Textarea id="o-notes" rows={3} value={f.notes} onChange={set("notes")} />
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Submitting…" : "Request onboarding"}
      </Button>
    </form>
  );
}
