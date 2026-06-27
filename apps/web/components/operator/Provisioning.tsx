"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { postWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Tenant = { id: string; name: string };
const ROLES = ["school_admin", "principal", "head_admin", "hr_manager"] as const;

export function Provisioning({ tenants }: { tenants: Tenant[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  // Provision a school
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [aName, setAName] = React.useState("");
  const [aEmail, setAEmail] = React.useState("");

  // Add an admin
  const [schoolId, setSchoolId] = React.useState(tenants[0]?.id ?? "");
  const [bName, setBName] = React.useState("");
  const [bEmail, setBEmail] = React.useState("");
  const [bRole, setBRole] = React.useState<(typeof ROLES)[number]>("school_admin");

  const provision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !slug || !aName || !aEmail) return;
    setBusy("provision");
    setResult(null);
    const res = await postWithStepUp("operator/tenants", {
      name, slug, admin: { name: aName, email: aEmail, role: "school_admin" },
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { admin: { email: string; tempPassword: string } };
      setResult(`School created. Admin ${d.admin.email} — temporary password: ${d.admin.tempPassword}`);
      setName(""); setSlug(""); setAName(""); setAEmail("");
      router.refresh();
    } else setResult(`Failed (${res.status}).`);
  };

  const addAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schoolId || !bName || !bEmail) return;
    setBusy("admin");
    setResult(null);
    const res = await postWithStepUp(`operator/tenants/${schoolId}/admins`, {
      name: bName, email: bEmail, role: bRole,
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { email: string; tempPassword: string };
      setResult(`Admin ${d.email} added — temporary password: ${d.tempPassword}`);
      setBName(""); setBEmail("");
      router.refresh();
    } else setResult(`Failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onboard a school</CardTitle>
        <CardDescription>Self-serve: create a tenant + its first admin, or add admins to an existing school. Step-up re-auth required.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={provision} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="pv-name">School name</Label><Input id="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="St. Mary's" /></div>
          <div className="space-y-1.5"><Label htmlFor="pv-slug">Slug</Label><Input id="pv-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="st-marys" className="w-32" /></div>
          <div className="space-y-1.5"><Label htmlFor="pv-aname">Admin name</Label><Input id="pv-aname" value={aName} onChange={(e) => setAName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="pv-aemail">Admin email</Label><Input id="pv-aemail" type="email" value={aEmail} onChange={(e) => setAEmail(e.target.value)} /></div>
          <Button type="submit" disabled={busy === "provision"}>Create school</Button>
        </form>

        {tenants.length > 0 && (
          <form onSubmit={addAdmin} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="ad-school">Existing school</Label>
              <select id="ad-school" value={schoolId} onChange={(e) => setSchoolId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="ad-name">Name</Label><Input id="ad-name" value={bName} onChange={(e) => setBName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="ad-email">Email</Label><Input id="ad-email" type="email" value={bEmail} onChange={(e) => setBEmail(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-role">Role</Label>
              <select id="ad-role" value={bRole} onChange={(e) => setBRole(e.target.value as (typeof ROLES)[number])} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button type="submit" variant="outline" disabled={busy === "admin"}>Add admin</Button>
          </form>
        )}

        {result && <p className="rounded-md bg-muted px-3 py-2 text-sm font-mono">{result}</p>}
      </CardContent>
    </Card>
  );
}
