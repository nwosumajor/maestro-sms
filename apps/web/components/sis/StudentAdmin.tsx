"use client";

import type { ContactDto, MedicalRecordDto, StudentProfileDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";

type Profile = Serialized<Partial<StudentProfileDto>>;
type Contact = Serialized<ContactDto>;
type Medical = Serialized<Partial<MedicalRecordDto>>;

async function send(path: string, method: string, body?: unknown) {
  return fetch(`/api/sms${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function Text({ id, label, value, onChange, type = "text" }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function StudentAdmin({
  studentId,
  canProfile,
  canContact,
  canMedical,
  profile,
  contacts,
  medical,
}: {
  studentId: string;
  canProfile: boolean;
  canContact: boolean;
  canMedical: boolean;
  profile: Profile | null;
  contacts: Contact[] | null;
  medical: Medical | null;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);

  // profile
  const [pf, setPf] = React.useState<Profile>({
    admissionNumber: profile?.admissionNumber ?? "",
    dateOfBirth: profile?.dateOfBirth ? String(profile.dateOfBirth).slice(0, 10) : "",
    gender: profile?.gender ?? "",
    phone: profile?.phone ?? "",
    email: profile?.email ?? "",
    addressLine1: profile?.addressLine1 ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    country: profile?.country ?? "",
    postalCode: profile?.postalCode ?? "",
  });
  const [pfBusy, setPfBusy] = React.useState(false);
  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault(); setPfBusy(true); setMsg(null);
    const body = Object.fromEntries(Object.entries(pf).map(([k, v]) => [k, v === "" ? null : v]));
    const res = await send(`/students/${studentId}/profile`, "PUT", body);
    setPfBusy(false); setMsg(res.ok ? "Profile saved." : await readApiError(res));
    if (res.ok) router.refresh();
  };

  // contacts
  const [c, setC] = React.useState({ name: "", relationship: "", phone: "", email: "", priority: 1 });
  const [cBusy, setCBusy] = React.useState(false);
  const addContact = async (e: React.FormEvent) => {
    e.preventDefault(); setCBusy(true);
    const res = await send(`/students/${studentId}/contacts`, "POST", {
      name: c.name, relationship: c.relationship, phone: c.phone, email: c.email || null, priority: c.priority,
    });
    setCBusy(false);
    if (res.ok) { setC({ name: "", relationship: "", phone: "", email: "", priority: 1 }); router.refresh(); }
  };
  const removeContact = async (id: string) => {
    if (!confirm("Remove this contact?")) return;
    const res = await send(`/students/${studentId}/contacts/${id}`, "DELETE");
    if (res.ok) router.refresh();
  };

  // medical
  const [md, setMd] = React.useState<Medical>({
    bloodGroup: medical?.bloodGroup ?? "",
    allergies: medical?.allergies ?? "",
    conditions: medical?.conditions ?? "",
    medications: medical?.medications ?? "",
    dietaryNotes: medical?.dietaryNotes ?? "",
    notes: medical?.notes ?? "",
  });
  const [mdBusy, setMdBusy] = React.useState(false);
  const saveMedical = async (e: React.FormEvent) => {
    e.preventDefault(); setMdBusy(true); setMsg(null);
    const body = Object.fromEntries(Object.entries(md).map(([k, v]) => [k, v === "" ? null : v]));
    // Medical edits are step-up gated: the shared sender handles the password
    // re-auth (prompt + retry on a wrong password) transparently.
    const res = await sendWithStepUp("PUT", `students/${studentId}/medical`, body);
    setMdBusy(false);
    setMsg(res.ok ? "Medical record saved." : await readApiError(res));
    if (res.ok) router.refresh();
  };

  if (!canProfile && !canContact && !canMedical) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-muted-foreground">Edit (staff)</h2>

      {canProfile && (
        <Card>
          <CardHeader><CardTitle className="text-base">Edit profile</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Text id="p-adm" label="Admission #" value={pf.admissionNumber ?? ""} onChange={(v) => setPf({ ...pf, admissionNumber: v })} />
                <Text id="p-dob" label="Date of birth" type="date" value={pf.dateOfBirth ?? ""} onChange={(v) => setPf({ ...pf, dateOfBirth: v })} />
                <Text id="p-gender" label="Gender" value={pf.gender ?? ""} onChange={(v) => setPf({ ...pf, gender: v })} />
                <Text id="p-phone" label="Phone" value={pf.phone ?? ""} onChange={(v) => setPf({ ...pf, phone: v })} />
                <Text id="p-email" label="Email" value={pf.email ?? ""} onChange={(v) => setPf({ ...pf, email: v })} />
                <Text id="p-addr" label="Address" value={pf.addressLine1 ?? ""} onChange={(v) => setPf({ ...pf, addressLine1: v })} />
                <Text id="p-city" label="City" value={pf.city ?? ""} onChange={(v) => setPf({ ...pf, city: v })} />
                <Text id="p-state" label="State" value={pf.state ?? ""} onChange={(v) => setPf({ ...pf, state: v })} />
                <Text id="p-country" label="Country" value={pf.country ?? ""} onChange={(v) => setPf({ ...pf, country: v })} />
              </div>
              <Button type="submit" disabled={pfBusy}>{pfBusy ? "Saving…" : "Save profile"}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canContact && (
        <Card>
          <CardHeader><CardTitle className="text-base">Emergency contacts</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(contacts ?? []).map((ct) => (
              <div key={ct.id} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                <span>{ct.name} · {ct.relationship} · {ct.phone}</span>
                <Button size="sm" variant="ghost" onClick={() => removeContact(ct.id)}>Remove</Button>
              </div>
            ))}
            <form onSubmit={addContact} className="flex flex-wrap items-end gap-2">
              <Text id="c-name" label="Name" value={c.name} onChange={(v) => setC({ ...c, name: v })} />
              <Text id="c-rel" label="Relationship" value={c.relationship} onChange={(v) => setC({ ...c, relationship: v })} />
              <Text id="c-phone" label="Phone" value={c.phone} onChange={(v) => setC({ ...c, phone: v })} />
              <Button type="submit" disabled={cBusy || !c.name || !c.relationship || !c.phone}>{cBusy ? "Adding…" : "Add contact"}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canMedical && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Edit medical record</CardTitle>
            <CardDescription>Sensitive — saving is audit-logged.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveMedical} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Text id="m-blood" label="Blood group" value={md.bloodGroup ?? ""} onChange={(v) => setMd({ ...md, bloodGroup: v })} />
                <Text id="m-allergy" label="Allergies" value={md.allergies ?? ""} onChange={(v) => setMd({ ...md, allergies: v })} />
                <Text id="m-cond" label="Conditions" value={md.conditions ?? ""} onChange={(v) => setMd({ ...md, conditions: v })} />
                <Text id="m-meds" label="Medications" value={md.medications ?? ""} onChange={(v) => setMd({ ...md, medications: v })} />
                <Text id="m-diet" label="Dietary notes" value={md.dietaryNotes ?? ""} onChange={(v) => setMd({ ...md, dietaryNotes: v })} />
              </div>
              <Button type="submit" disabled={mdBusy}>{mdBusy ? "Saving…" : "Save medical"}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
