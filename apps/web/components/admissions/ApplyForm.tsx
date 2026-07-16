"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ApplyForm() {
  const [f, setF] = React.useState({
    schoolSlug: "demo",
    applicantName: "",
    applicantEmail: "",
    applicantPhone: "",
    childName: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await fetch("/api/public/admissions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f),
    });
    if (res.ok) {
      // Schools may charge an admission-form fee: the intake response then
      // carries the hosted-checkout handoff — the application is already saved,
      // so a payment abandoned here can be completed later from the same link.
      const data = (await res.json()) as {
        formFeeMinor?: number;
        payment?: { authorizationUrl: string } | null;
      };
      if (data.payment?.authorizationUrl) {
        window.location.href = data.payment.authorizationUrl;
        return;
      }
      setBusy(false);
      setDone(true);
      return;
    }
    setBusy(false);
    setErr(res.status === 404 ? "School not found." : `Something went wrong (${res.status}).`);
  };

  if (done) {
    return <p className="text-sm">Thank you — your application has been received. The school will be in touch.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5"><Label htmlFor="a-school">School code</Label><Input id="a-school" value={f.schoolSlug} onChange={set("schoolSlug")} required /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="a-name">Your name</Label><Input id="a-name" value={f.applicantName} onChange={set("applicantName")} required /></div>
        <div className="space-y-1.5"><Label htmlFor="a-email">Email</Label><Input id="a-email" type="email" value={f.applicantEmail} onChange={set("applicantEmail")} required /></div>
        <div className="space-y-1.5"><Label htmlFor="a-phone">Phone</Label><Input id="a-phone" value={f.applicantPhone} onChange={set("applicantPhone")} /></div>
        <div className="space-y-1.5"><Label htmlFor="a-child">Child's name</Label><Input id="a-child" value={f.childName} onChange={set("childName")} required /></div>
      </div>
      <div className="space-y-1.5"><Label htmlFor="a-notes">Anything else?</Label><Textarea id="a-notes" rows={3} value={f.notes} onChange={set("notes")} /></div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button>
    </form>
  );
}
