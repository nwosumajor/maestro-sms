"use client";

// =============================================================================
// Awards — achievement badges for a class (client island)
// =============================================================================
// Students see the badges they've earned (celebration); teachers additionally
// get an award form (pick a student + badge) and can revoke a mistaken one. The
// catalog (LMS_BADGES) is shared from @sms/types so labels/icons never drift.
// Positive recognition only — the API enforces teacher-of-class + enrolment.
// =============================================================================

import type { LmsAwardDto, Serialized } from "@sms/types";
import { LMS_BADGES, badgeMeta } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Award = Serialized<LmsAwardDto>;
type Student = { studentId: string; studentName: string };

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false as const, error };
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function Awards({ classId, canManage }: { classId: string; canManage: boolean }) {
  const [awards, setAwards] = React.useState<Award[]>([]);
  const [roster, setRoster] = React.useState<Student[]>([]);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const a = await req("GET", `/classes/${classId}/awards`);
    if (a.ok) setAwards(a.data as Award[]);
    else setErr(a.error);
    if (canManage) {
      const r = await req("GET", `/classes/${classId}/progress`);
      if (r.ok) setRoster(((r.data as { students: Student[] }).students ?? []).map((s) => ({ studentId: s.studentId, studentName: s.studentName })));
    }
  }, [classId, canManage]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setErr(null);
    const r = await req("DELETE", `/awards/${id}`);
    if (r.ok) void load();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Achievements</CardTitle>
        <CardDescription>
          {canManage ? "Recognise a student’s effort with a badge." : "Badges you’ve earned in this class."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && <AwardForm classId={classId} roster={roster} onAwarded={load} />}

        {awards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No badges yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {awards.map((a) => {
              const m = badgeMeta(a.badge);
              return (
                <div key={a.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="text-xl" aria-hidden>
                    {m.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {canManage && <>{a.studentName} · </>}
                      {a.note ? a.note : m.description} · {when(a.createdAt)}
                    </div>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => revoke(a.id)}>
                      ✕
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function AwardForm({ classId, roster, onAwarded }: { classId: string; roster: Student[]; onAwarded: () => void }) {
  const [studentId, setStudentId] = React.useState("");
  const [badge, setBadge] = React.useState<string>(LMS_BADGES[0].key);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  async function submit() {
    if (!studentId) return;
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/classes/${classId}/awards`, { studentId, badge, note: note.trim() || undefined });
    setBusy(false);
    if (r.ok) {
      setNote("");
      onAwarded();
    } else setErr(r.error);
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
      <select aria-label="Student" className={sel} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
        <option value="">Select student…</option>
        {roster.map((s) => (
          <option key={s.studentId} value={s.studentId}>
            {s.studentName}
          </option>
        ))}
      </select>
      <select aria-label="Badge" className={sel} value={badge} onChange={(e) => setBadge(e.target.value)}>
        {LMS_BADGES.map((b) => (
          <option key={b.key} value={b.key}>
            {b.icon} {b.label}
          </option>
        ))}
      </select>
      <Input className="w-48" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" onClick={submit} disabled={!studentId || busy}>
        Award badge
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
