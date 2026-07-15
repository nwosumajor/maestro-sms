"use client";

// =============================================================================
// PlatformStaff — the owner hiring (and revoking) help
// =============================================================================
// Owner-only (platform.staff.manage): staff creating staff would mean one manager
// could mint another, and "only the owner has absolute control" quietly dissolves.
// The API pins the role to manager_admin, so this panel can never mint a second
// super_admin however it is driven.
//
// Invite-link only — we never show or send a password (same posture as school
// onboarding). New staff are created MFA-mandatory and must set a password on
// first login.
// =============================================================================

import { useEffect, useState } from "react";
import type { Serialized } from "@sms/types";
import type { PlatformStaffDto } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

type Staff = Serialized<PlatformStaffDto>;

export function PlatformStaff() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/sms/operator/platform-staff");
    if (res.ok) setStaff((await res.json()) as Staff[]);
    else setNote(interpretApiError(res.status, await res.text()));
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    setNote(null);
    const res = await sendWithStepUp("POST", "operator/platform-staff", { email, name });
    if (res.ok) {
      setEmail("");
      setName("");
      setNote(`Invited ${email}. They'll get a one-time link to set their password; MFA is mandatory.`);
      await load();
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(null);
  }

  async function setStatus(id: string, status: "ACTIVE" | "DISABLED") {
    if (status === "DISABLED" && !window.confirm("Revoke this manager? They will be signed out and blocked from logging in.")) return;
    setBusy(id);
    setNote(null);
    const res = await sendWithStepUp("PUT", `operator/platform-staff/${id}/status`, { status });
    if (!res.ok) setNote(interpretApiError(res.status, await res.text()));
    await load();
    setBusy(null);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Platform staff</h2>
        <span className="text-xs text-muted-foreground">manager_admin — delegated duties, never ownership</span>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        Managers can view tenants, onboard schools, review signup requests, read the platform audit trail and
        unlock accounts. They cannot impersonate, reset credentials, change pricing or subscriptions, disable a
        school, or read student records — those stay with you.
      </p>

      <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          placeholder="name@yourcompany.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-8 w-64 text-sm"
        />
        <Input
          required
          placeholder="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-48 text-sm"
        />
        <Button type="submit" size="sm" className="h-8" disabled={busy === "add"}>
          {busy === "add" ? "Inviting…" : "Invite manager"}
        </Button>
      </form>

      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}

      <ul className="divide-y divide-border/70">
        {staff?.length === 0 && <li className="py-2 text-xs text-muted-foreground">No platform staff yet.</li>}
        {staff?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{s.name}</span>
                <Badge variant={s.status === "ACTIVE" ? "secondary" : "destructive"}>{s.status.toLowerCase()}</Badge>
                {!s.activated && <Badge variant="outline">invite pending</Badge>}
                {s.mfaEnabled ? <Badge variant="secondary">2FA on</Badge> : <Badge variant="outline">2FA not set up</Badge>}
              </div>
              <span className="text-xs text-muted-foreground">{s.email}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={busy === s.id}
              onClick={() => setStatus(s.id, s.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}
            >
              {s.status === "ACTIVE" ? "Revoke" : "Reinstate"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
