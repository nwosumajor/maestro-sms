"use client";

import * as React from "react";
import type { PublicSchoolDto } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_SCHOOLS = 2;

export function EnrollForm({ schools, preselect }: { schools: PublicSchoolDto[]; preselect?: string }) {
  const [selected, setSelected] = React.useState<string[]>(
    preselect && schools.some((s) => s.slug === preselect) ? [preselect] : [],
  );
  const [f, setF] = React.useState({
    parentName: "",
    parentEmail: "",
    parentPhone: "",
    parentAddress: "",
    relationship: "",
    childName: "",
    childDob: "",
    childGender: "",
    desiredClass: "",
    priorSchool: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const toggle = (slug: string) => {
    setSelected((cur) => {
      if (cur.includes(slug)) return cur.filter((s) => s !== slug);
      if (cur.length >= MAX_SCHOOLS) return cur;
      return [...cur, slug];
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) {
      setErr("Please select at least one school.");
      return;
    }
    if (!f.parentName || !f.parentEmail || !f.childName) {
      setErr("Please complete the required fields.");
      return;
    }
    setBusy(true);
    setErr(null);
    const details = {
      parentName: f.parentName,
      parentEmail: f.parentEmail,
      parentPhone: f.parentPhone || null,
      parentAddress: f.parentAddress || null,
      relationship: f.relationship || null,
      childName: f.childName,
      childDob: f.childDob || null,
      childGender: f.childGender || null,
      desiredClass: f.desiredClass || null,
      priorSchool: f.priorSchool || null,
      notes: f.notes || null,
    };
    const ok: string[] = [];
    for (const slug of selected) {
      const res = await fetch("/api/public/admissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolSlug: slug,
          applicantName: f.parentName,
          applicantEmail: f.parentEmail,
          applicantPhone: f.parentPhone || null,
          childName: f.childName,
          childDob: f.childDob || null,
          desiredClass: f.desiredClass || null,
          notes: f.notes || null,
          details,
        }),
      });
      if (res.ok) ok.push(slug);
    }
    setBusy(false);
    if (ok.length === selected.length) setDone(ok);
    else setErr(`Submitted ${ok.length} of ${selected.length}. Please retry the rest.`);
  };

  if (done) {
    const names = schools.filter((s) => done.includes(s.slug)).map((s) => s.name);
    return (
      <p className="text-sm">
        Thank you — your enrolment application for <strong>{f.childName}</strong> has been submitted to{" "}
        {names.join(" and ")}. Each school will review it and email you the entrance-exam date once decided.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <Label>Choose up to two schools</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {schools.map((s) => {
            const on = selected.includes(s.slug);
            const disabled = !on && selected.length >= MAX_SCHOOLS;
            return (
              <label
                key={s.id}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  on ? "border-primary bg-primary/5" : "border-border"
                } ${disabled ? "opacity-50" : ""}`}
              >
                <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(s.slug)} />
                {s.name}
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Parent / guardian</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="e-pn">Full name *</Label><Input id="e-pn" value={f.parentName} onChange={set("parentName")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-pe">Email *</Label><Input id="e-pe" type="email" value={f.parentEmail} onChange={set("parentEmail")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-pp">Phone</Label><Input id="e-pp" value={f.parentPhone} onChange={set("parentPhone")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-rel">Relationship to child</Label><Input id="e-rel" value={f.relationship} onChange={set("relationship")} placeholder="Mother / Father / Guardian" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="e-addr">Home address</Label><Input id="e-addr" value={f.parentAddress} onChange={set("parentAddress")} /></div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Child</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="e-cn">Full name *</Label><Input id="e-cn" value={f.childName} onChange={set("childName")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-dob">Date of birth</Label><Input id="e-dob" type="date" value={f.childDob} onChange={set("childDob")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-gen">Gender</Label><Input id="e-gen" value={f.childGender} onChange={set("childGender")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-cls">Desired class / grade</Label><Input id="e-cls" value={f.desiredClass} onChange={set("desiredClass")} placeholder="JSS1" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="e-prior">Previous school</Label><Input id="e-prior" value={f.priorSchool} onChange={set("priorSchool")} /></div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="e-notes">Anything else (medical needs, notes)?</Label>
        <Textarea id="e-notes" rows={3} value={f.notes} onChange={set("notes")} />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Submitting…" : `Submit application${selected.length > 1 ? "s" : ""}`}
      </Button>
    </form>
  );
}
