"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CreateUserForm({ roles }: { roles: string[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState(roles[0] ?? "teacher");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !role) return;
    setBusy(true);
    setResult(null);
    const res = await postSms<{ email: string; role: string; tempPassword: string }>("admin/users", {
      name,
      email,
      role,
    });
    setBusy(false);
    if (res.ok && res.data) {
      setResult(`Created ${res.data.role} ${res.data.email} — temporary password: ${res.data.tempPassword}`);
      setName("");
      setEmail("");
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
          Add a teacher, accountant, parent, student or other staff member to your school. They receive a
          one-time temporary password. Roles are platform-defined; use Roles &amp; access to change them later.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">Full name</Label>
            <Input id="cu-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-email">Email</Label>
            <Input id="cu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
