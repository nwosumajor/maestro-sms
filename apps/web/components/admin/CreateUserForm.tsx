"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { requiresContactEmail } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CreateUserForm({ roles }: { roles: string[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [role, setRole] = React.useState(roles[0] ?? "teacher");
  // Sign-in identifiers are generated from the name and the school's own domain,
  // so the only address we ask for is the REAL one mail goes to. Students are
  // exempt: their guardians are notified, and most pupils have no address.
  const contactRequired = requiresContactEmail(role);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !role) return;
    if (contactRequired && !contactEmail.trim()) {
      setResult(`A contact email is required for a ${role} — it is where their sign-in invite and password resets are sent.`);
      return;
    }
    setBusy(true);
    setResult(null);
    const res = await postSms<{ email: string; role: string; tempPassword: string; pendingApproval?: boolean }>(
      "admin/users",
      { name, role, ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}) },
    );
    setBusy(false);
    if (res.ok && res.data) {
      // junior_admin is maker-checker: the account exists (role-less) and the
      // role lands only after a different senior approves under Approvals.
      setResult(
        res.data.pendingApproval
          ? `Created. Sign-in ID: ${res.data.email} — temporary password: ${res.data.tempPassword}. The ${res.data.role} role is AWAITING APPROVAL by a different senior (see Approvals); the account has no access until then.`
          : `Created ${res.data.role}. Sign-in ID: ${res.data.email} — temporary password: ${res.data.tempPassword}. This ID is for signing in only; it does not receive mail.`,
      );
      setName("");
      setContactEmail("");
      router.refresh();
    } else {
      setResult(`Failed (${res.status}). ${res.error ?? ""}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create a profile</CardTitle>
        <CardDescription>
          Add a teacher, accountant, parent, student or other staff member. Their sign-in ID is generated
          from their name and your school&apos;s domain — you don&apos;t enter it. Staff and parents must have a
          contact email: that is where the invite, password resets and notices actually go.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">Full name</Label>
            <Input id="cu-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-contact">
              Contact email{contactRequired ? <span className="text-destructive"> *</span> : " (optional)"}
            </Label>
            <Input
              id="cu-contact"
              type="email"
              value={contactEmail}
              required={contactRequired}
              placeholder={contactRequired ? "where invites & resets are sent" : "students: optional"}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-role">Role</Label>
            <select
              id="cu-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create profile"}
          </Button>
        </form>
        {result && <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm font-mono">{result}</p>}
      </CardContent>
    </Card>
  );
}
