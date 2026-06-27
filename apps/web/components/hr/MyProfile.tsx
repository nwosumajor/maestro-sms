"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { SelfProfileDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Profile = Serialized<SelfProfileDto>;

export function MyProfile({ profile }: { profile: Profile | null }) {
  const router = useRouter();
  const [phone, setPhone] = React.useState(profile?.phone ?? "");
  const [address, setAddress] = React.useState(profile?.address ?? "");
  const [nextOfKin, setNextOfKin] = React.useState(profile?.nextOfKin ?? "");
  const [nextOfKinPhone, setNextOfKinPhone] = React.useState(profile?.nextOfKinPhone ?? "");
  const [bankName, setBankName] = React.useState(profile?.bankName ?? "");
  const [bankAccount, setBankAccount] = React.useState(profile?.bankAccount ?? "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (!profile) {
    return (
      <Alert variant="info">
        <AlertTitle>No HR record yet</AlertTitle>
        <AlertDescription>Ask HR to create your employee record, then you can maintain your contact and bank details here.</AlertDescription>
      </Alert>
    );
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: phone || null, address: address || null,
        nextOfKin: nextOfKin || null, nextOfKinPhone: nextOfKinPhone || null,
        bankName: bankName || null, bankAccount: bankAccount || null,
      }),
    });
    setBusy(false);
    if (res.ok) { setMsg("Saved."); router.refresh(); } else setMsg(`Failed (${res.status}).`);
  };

  const erasePersonal = async () => {
    if (!window.confirm("Erase your contact, next-of-kin and bank details? Your employment record is retained.")) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/me/erase-personal", { method: "POST" });
    setBusy(false);
    if (res.ok) {
      setPhone(""); setAddress(""); setNextOfKin(""); setNextOfKinPhone(""); setBankName(""); setBankAccount("");
      setMsg("Personal details erased."); router.refresh();
    } else setMsg(`Failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My profile — {profile.jobTitle}{profile.department ? ` · ${profile.department}` : ""}</CardTitle>
        <CardDescription>Your contact, next-of-kin and bank details. Bank details are encrypted at rest and visible only to you and payroll.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="mp-phone">Phone</Label><Input id="mp-phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-addr">Address</Label><Input id="mp-addr" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-nok">Next of kin</Label><Input id="mp-nok" value={nextOfKin} onChange={(e) => setNextOfKin(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-nokp">Next-of-kin phone</Label><Input id="mp-nokp" value={nextOfKinPhone} onChange={(e) => setNextOfKinPhone(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-bank">Bank name</Label><Input id="mp-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-acct">Bank account</Label><Input id="mp-acct" value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} /></div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</Button>
            <a href="/api/sms/hr/me/export" className="text-sm text-primary underline">Export my data (NDPR)</a>
            <Button type="button" variant="outline" disabled={busy} onClick={erasePersonal}>Erase personal details</Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
