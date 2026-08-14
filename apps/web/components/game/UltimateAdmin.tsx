"use client";

// Staff/admin actions for the cross-school Ultimate (spec §7):
//  - EnrollSchoolButton  — tier-1 school opt-in (principal/school_admin)
//  - ConsentForm         — tier-2 per-student guardian consent (school_admin)
//  - CreateUltimateForm  — create a competition (super_admin only)
// All gating is enforced server-side; these only render for permitted callers.

import type { IdNameDto, Serialized, UltimateCompetitionDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postSms } from "./play-ui";
import { readApiError } from "@/lib/api-error";

type Person = Serialized<IdNameDto>;

export function EnrollSchoolButton({ competitionId, enrolled }: { competitionId: string; enrolled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  if (enrolled) return <p className="text-sm text-muted-foreground">Your school is enrolled.</p>;
  return (
    <div className="flex items-center gap-3">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await postSms(`ultimate/competitions/${competitionId}/enroll`);
          setBusy(false);
          if (r.ok) router.refresh();
          else setMsg(r.error ?? `Failed (${r.status}).`);
        }}
      >
        {busy ? "…" : "Enroll our school"}
      </Button>
      {msg && <p className="text-sm text-destructive">{msg}</p>}
      <p className="text-xs text-muted-foreground">Requires cross-school play enabled in game settings.</p>
    </div>
  );
}

export function ConsentForm({ students, guardians }: { students: Person[]; guardians: Person[] }) {
  const [studentId, setStudentId] = React.useState(students[0]?.id ?? "");
  const [granted, setGranted] = React.useState(true);
  // WHO gave it. The row used to record only the admin who ticked the box, on
  // the one surface where a pupil's handle and school leave the tenant.
  const [guardianId, setGuardianId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (students.length === 0) {
    return <p className="text-sm text-muted-foreground">No students available.</p>;
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="cons-student">Student</Label>
        <select
          id="cons-student"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex h-9 items-center gap-2 text-sm">
        <input type="checkbox" checked={granted} onChange={(e) => setGranted(e.target.checked)} className="h-4 w-4" />
        Guardian consent granted
      </label>
      {/* Only when granting: withdrawing consent must never be harder than
          giving it, so revoking needs no guardian named. */}
      {granted && (
        <div className="space-y-1.5">
          <Label htmlFor="cons-guardian">Consent given by</Label>
          <select
            id="cons-guardian"
            value={guardianId}
            onChange={(e) => setGuardianId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Select the guardian…</option>
            {guardians.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <Button
        disabled={busy || !studentId || (granted && !guardianId)}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const res = await fetch("/api/sms/ultimate/consent", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId, granted, guardianId: granted ? guardianId : undefined }),
          });
          setBusy(false);
          setMsg(res.ok ? "Consent updated." : await readApiError(res));
        }}
      >
        {busy ? "…" : "Save consent"}
      </Button>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function CreateUltimateForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [len, setLen] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="space-y-1.5 flex-1">
        <Label htmlFor="ult-name">Name</Label>
        <Input id="ult-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="National Open" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ult-diff">Difficulty</Label>
        <select
          id="ult-diff"
          value={len}
          onChange={(e) => setLen(Number(e.target.value))}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value={4}>4</option>
          <option value={5}>5</option>
          <option value={6}>6</option>
        </select>
      </div>
      <Button
        disabled={busy || name.trim().length === 0}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await postSms<Serialized<UltimateCompetitionDto>>("ultimate/competitions", {
            name: name.trim(),
            difficultyLength: len,
            startAt: plusDays(0),
            endAt: plusDays(30),
          });
          if (r.ok) {
            setName("");
            router.refresh();
          } else setMsg(r.error ?? `Failed (${r.status}).`);
          setBusy(false);
        }}
      >
        {busy ? "…" : "Create competition"}
      </Button>
      {msg && <p className="text-sm text-destructive">{msg}</p>}
    </div>
  );
}
