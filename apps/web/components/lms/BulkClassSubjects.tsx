"use client";

// Attach several subjects to a class at once, each with its teacher.
//
// The endpoint existed and nothing called it: setting up a class meant
// submitting the single-subject form nine or ten times, one round trip each.
//
// The server is all-or-nothing here — it validates every subject, teacher and
// room up front and refuses the whole batch if one is wrong, and it REFUSES a
// batch naming the same subject twice. That is the right behaviour for a set-up
// action, and it makes two things the UI's job:
//
//   * never send a duplicate subject. The subject dropdown drops what is already
//     staged, so the batch cannot be built wrong in the first place;
//   * stage visibly before committing, because an all-or-nothing write of ten
//     rows is not something to trigger from a dropdown.
//
// `lessonsPerWeek` and the preferred room are the timetable solver's inputs.
// They are optional here for the same reason the single form leaves them
// optional: sending a blank would reset a quota somebody had already set.

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";

type Named = Serialized<IdNameDto>;
type User = { id: string; name: string; roles: string[] };
type Row = { subjectId: string; teacherId: string; lessonsPerWeek: string; preferredRoomId: string };

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const blank = (): Row => ({ subjectId: "", teacherId: "", lessonsPerWeek: "", preferredRoomId: "" });

export function BulkClassSubjects({
  classes,
  subjects,
  users,
  rooms = [],
}: {
  classes: Named[];
  subjects: Named[];
  users: User[];
  rooms?: Named[];
}) {
  const router = useRouter();
  const teachers = users.filter((u) => u.roles.includes("teacher"));
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [rows, setRows] = React.useState<Row[]>([blank()]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (classes.length === 0 || subjects.length === 0) return null;

  const set = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const ready = rows.filter((r) => r.subjectId && r.teacherId);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/classes/${classId}/subjects/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ready.map((r) => ({
          subjectId: r.subjectId,
          teacherId: r.teacherId,
          // Omitted when blank, so a re-run never resets a stored quota or room.
          ...(r.lessonsPerWeek !== "" ? { lessonsPerWeek: Number(r.lessonsPerWeek) } : {}),
          ...(r.preferredRoomId !== "" ? { preferredRoomId: r.preferredRoomId } : {}),
        })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      // All-or-nothing: nothing was written, so the message must say what to fix
      // rather than leave the reader wondering which rows landed.
      setMsg(await readApiError(res));
      return;
    }
    const out = (await res.json()) as { assigned: number };
    setMsg(`Assigned ${out.assigned} subject${out.assigned === 1 ? "" : "s"} to this class.`);
    setRows([blank()]);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Attach several subjects</CardTitle>
        <CardDescription>
          Set a class up in one go: a teacher per subject, and optionally the lessons-per-week and room the timetable
          solver should use. Either the whole batch is saved or none of it is.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="mb-1 block">Class</Label>
          <select aria-label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} className={sel}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          {rows.map((r, i) => {
            // A subject already staged on another row is not offered again — the
            // server refuses a batch naming one twice, and a form that can build
            // an invalid batch is a form that will.
            const taken = new Set(rows.filter((_, n) => n !== i).map((x) => x.subjectId).filter(Boolean));
            return (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <select
                  aria-label="Subject"
                  value={r.subjectId}
                  onChange={(e) => set(i, { subjectId: e.target.value })}
                  className={sel}
                >
                  <option value="">Subject…</option>
                  {subjects
                    .filter((s) => !taken.has(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Teacher"
                  value={r.teacherId}
                  onChange={(e) => set(i, { teacherId: e.target.value })}
                  className={sel}
                >
                  <option value="">Teacher…</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Lessons per week"
                  className={`${sel} w-32`}
                  type="number"
                  min={1}
                  max={20}
                  placeholder="lessons/wk"
                  value={r.lessonsPerWeek}
                  onChange={(e) => set(i, { lessonsPerWeek: e.target.value })}
                />
                {rooms.length > 0 && (
                  <select
                    aria-label="Preferred room"
                    value={r.preferredRoomId}
                    onChange={(e) => set(i, { preferredRoomId: e.target.value })}
                    className={sel}
                  >
                    <option value="">Any room</option>
                    {rooms.map((rm) => (
                      <option key={rm.id} value={rm.id}>
                        {rm.name}
                      </option>
                    ))}
                  </select>
                )}
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setRows((prev) => prev.filter((_, n) => n !== i))}
                  >
                    Remove<span className="sr-only"> row {i + 1}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRows((prev) => [...prev, blank()])}>
            Add another
          </Button>
          <Button size="sm" disabled={busy || ready.length === 0} onClick={() => void submit()}>
            Assign {ready.length || ""}
          </Button>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
