"use client";

import type { IdNameDto, UserSummaryDto, Serialized } from "@sms/types";
import {
  CLASS_ARMS,
  CLASS_STREAMS,
  CLASS_STREAM_LABELS,
  SUBJECT_STAGES,
  SUBJECT_STAGE_LABELS,
  composeClassName,
} from "@sms/types";
import { StudentPicker } from "@/components/people/StudentPicker";
import { UserPicker } from "@/components/people/UserPicker";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { personLabel } from "@/lib/people";

type Named = Serialized<IdNameDto>;
type User = Serialized<UserSummaryDto>;

/** One definition of the select styling, shared by both forms on this card. */
const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export function ClassAdmin({
  classes,
  students = [],
  users,
  rooms = [],
}: {
  classes: Named[];
  students?: Named[];
  users: User[];
  /** Rooms the school has defined. Empty when the caller cannot read them, in
   *  which case the base-room control simply is not offered — an empty picker
   *  that always fails would be worse than no picker. */
  rooms?: Named[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const teachers = users.filter((u) => u.roles.includes("teacher"));
  // EVERY CLASS HAS A CLASS TEACHER. They take its register and answer for it,
  // so the class cannot be created without naming one — the API refuses, and a
  // form that let you try would just produce a 400.
  const [classTeacherId, setClassTeacherId] = React.useState("");

  const post = async (path: string, body: unknown, ok: string) => {
    const res = await fetch(`/api/sms${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    setMsg(res.ok ? ok : await readApiError(res));
    if (res.ok) router.refresh();
    return res.ok;
  };

  // create class
  const [cls, setCls] = React.useState({ name: "" });
  // assign teacher
  // The class name is COMPOSED from what was chosen, never typed. A typed name
  // is how "SS3 Science A", "SS3 Sci A" and "SS3-SCIENCE-A" end up as three
  // year groups that no report can compare.
  const [shape, setShape] = React.useState<{ stage: string; level: string; stream: string; arm: string }>({
    stage: "SENIOR_SECONDARY",
    level: "3",
    stream: "SCIENCE",
    arm: "",
  });
  const composed = composeClassName({
    stage: shape.stage || null,
    level: shape.level ? Number(shape.level) : null,
    stream: shape.stream || null,
    arm: shape.arm || null,
  });

  const [at, setAt] = React.useState({ classId: classes[0]?.id ?? "", teacherId: teachers[0]?.id ?? "" });

  // The class roster already carries its teachers, so this needs no new
  // endpoint — null means "still loading", [] means genuinely nobody.
  const [homeRoomId, setHomeRoomId] = React.useState("");
  const [assigned, setAssigned] = React.useState<Array<{ id: string; name: string }> | null>(null);
  const loadAssigned = React.useCallback(async (classId: string) => {
    if (!classId) { setAssigned([]); return; }
    setAssigned(null);
    const res = await fetch(`/api/sms/classes/${classId}`);
    if (!res.ok) { setAssigned([]); return; }
    const roster = (await res.json()) as { teachers?: Array<{ teacher?: { id: string; name: string } }> };
    setAssigned((roster.teachers ?? []).map((t) => t.teacher).filter((t): t is { id: string; name: string } => !!t));
  }, []);
  React.useEffect(() => { void loadAssigned(at.classId); }, [at.classId, loadAssigned]);
  // enroll
  const [en, setEn] = React.useState({ classId: classes[0]?.id ?? "", studentId: students[0]?.id ?? "" });
  // link guardian
  const [lg, setLg] = React.useState({ parentId: "", studentId: students[0]?.id ?? "" });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Manage classes</CardTitle>
        <CardDescription>Create classes and manage teaching, enrollment, and guardians.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await post(
              "/classes",
              {
                name: composed,
                supervisorId: classTeacherId || null,
                stage: shape.stage || null,
                level: shape.level ? Number(shape.level) : null,
                stream: shape.stream || null,
                arm: shape.arm || null,
                homeRoomId: homeRoomId || null,
              },
              "Class created.",
            );
          }}
          className="flex flex-wrap items-end gap-2"
        >
          {/* A class is a COHORT — its subjects are defined per class in
              "Subjects, teachers & progression", not typed here. Everything
              below is CHOSEN, so the structured fields and the name can never
              disagree and no two arms can be spelled differently. */}
          <div className="space-y-1.5">
            <Label htmlFor="cl-stage">Section</Label>
            <select id="cl-stage" value={shape.stage} onChange={(e) => setShape({ ...shape, stage: e.target.value })} className={sel}>
              {SUBJECT_STAGES.map((st) => <option key={st} value={st}>{SUBJECT_STAGE_LABELS[st]}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-level">Year</Label>
            <select id="cl-level" value={shape.level} onChange={(e) => setShape({ ...shape, level: e.target.value })} className={sel}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-stream">Stream</Label>
            <select id="cl-stream" value={shape.stream} onChange={(e) => setShape({ ...shape, stream: e.target.value })} className={sel}>
              <option value="">— none —</option>
              {CLASS_STREAMS.map((st) => <option key={st} value={st}>{CLASS_STREAM_LABELS[st]}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-arm">Arm</Label>
            <select id="cl-arm" value={shape.arm} onChange={(e) => setShape({ ...shape, arm: e.target.value })} className={sel}>
              <option value="">— single class —</option>
              {CLASS_ARMS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-teacher">Class teacher (optional)</Label>
            <select
              id="cl-teacher"
              value={classTeacherId}
              onChange={(e) => setClassTeacherId(e.target.value)}
              className={sel}
            >
              {/* SET LATER IS ALLOWED. Laying out next year's classes before the
                  staffing is settled is how schools actually work, and a required
                  field people satisfy by naming whoever is in the dropdown is
                  worse than an empty one: a wrong name is acted on, an empty one
                  is chased. The classes list flags every class without one and
                  can filter to exactly those. */}
              <option value="">— assign later —</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-room">Base room</Label>
            <select id="cl-room" value={homeRoomId} onChange={(e) => setHomeRoomId(e.target.value)} className={sel}>
              {/* OPTIONAL, and it says so: plenty of schools rotate rooms, and an
                  invented default would be a lie about where a child can be
                  found. One class per room — the refusal names the class that
                  already has it. */}
              <option value="">— none —</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Will be called</Label>
            <p className="flex h-9 items-center rounded-md border border-dashed border-border px-3 text-sm font-medium">
              {composed || "—"}
            </p>
          </div>
          <Button type="submit" size="sm" disabled={!composed}>Create class</Button>
        </form>

        <ArmsBuilder teachers={teachers} rooms={rooms} shape={shape} onDone={(m) => { setMsg(m); router.refresh(); }} />

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post(`/classes/${at.classId}/teachers`, { teacherId: at.teacherId }, "Teacher assigned.")) {
              void loadAssigned(at.classId);
            }
          }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Assign teacher</Label>
          <select aria-label="Class" value={at.classId} onChange={(e) => setAt({ ...at, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Teacher" value={at.teacherId} onChange={(e) => setAt({ ...at, teacherId: e.target.value })} className={sel}>
            {teachers.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={!at.teacherId}>Assign</Button>
        </form>

        {/* WHO IS ALREADY ASSIGNED. The form was write-only: you picked a class
            and a teacher and clicked Assign, never seeing the current state —
            and there was no way to take an assignment back at all. A class
            teacher holds the widest access in the product (roster, grades,
            documents, and publishing to every pupil), so it has to be
            revocable, and revoking starts with being able to see it. */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Class teacher of {classes.find((c) => c.id === at.classId)?.name ?? "this class"}
          </p>
          {assigned === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : assigned.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nobody yet — this class has no one responsible for its register. Assign a class teacher above.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assigned.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                  {t.name}
                </span>
              ))}
            </div>
          )}
          {/* NO REMOVE. A class teacher is the class SUPERVISOR — they take its
              register — and every class must have one, so the server refuses to
              take the last one off. Handing the class to somebody else is what
              replaces them, and that is the form above; an × that always failed
              would be an affordance that cannot work. */}
        </div>

        <form
          onSubmit={async (e) => { e.preventDefault(); await post(`/classes/${en.classId}/enrollments`, { studentId: en.studentId }, "Student enrolled."); }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Enroll student</Label>
          <select aria-label="Class" value={en.classId} onChange={(e) => setEn({ ...en, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {/* Searched, not enumerated — this page used to receive the whole roster
              purely to fill these two controls. */}
          <div className="w-56"><StudentPicker value={en.studentId} onChange={(id) => setEn({ ...en, studentId: id })} seed={students} /></div>
          <Button type="submit" size="sm" variant="outline" disabled={!en.studentId}>Enroll</Button>
        </form>

        <form
          onSubmit={async (e) => { e.preventDefault(); await post("/guardians", { parentId: lg.parentId, studentId: lg.studentId }, "Guardian linked."); }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Link guardian</Label>
          {/* Searched, not enumerated — this control used to be the reason the page
              fetched every guardian in the school on every load. */}
          <div className="w-56">
            <UserPicker kind="parent" value={lg.parentId} onChange={(id) => setLg({ ...lg, parentId: id })} placeholder="Search guardians…" />
          </div>
          <div className="w-56"><StudentPicker value={lg.studentId} onChange={(id) => setLg({ ...lg, studentId: id })} seed={students} /></div>
          <Button type="submit" size="sm" variant="outline" disabled={!lg.parentId || !lg.studentId}>Link</Button>
        </form>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * SS1A, SS1B, SS1C in one action.
 *
 * The single form above already makes the NAME consistent — Section, Year,
 * Stream and Arm are chosen, never typed. What it did not make consistent was
 * the WORK: three year groups of three arms meant nine passes, re-picking the
 * same Section, Year and Stream eight times, with nothing stopping the ninth
 * from differing from the first.
 *
 * It reuses the shape already chosen above rather than asking for it twice, so
 * the two cannot disagree about what is being created.
 */
function ArmsBuilder({
  teachers,
  rooms,
  shape,
  onDone,
}: {
  teachers: User[];
  rooms: Named[];
  shape: { stage: string; level: string; stream: string; arm: string };
  onDone: (msg: string) => void;
}) {
  const [rows, setRows] = React.useState<Array<{ arm: string; supervisorId: string; homeRoomId: string }>>([
    { arm: "A", supervisorId: "", homeRoomId: "" },
    { arm: "B", supervisorId: "", homeRoomId: "" },
  ]);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  // EVERY arm needs its own class teacher — the same rule the single form
  // enforces, stated here so the button is disabled rather than the request
  // refused.
  // A class teacher may be set later, so only the arm letter is required here.
  const ready = rows.length > 0 && rows.every((r) => r.arm);
  const preview = rows
    .map((r) => composeClassName({ stage: shape.stage as never, level: shape.level ? Number(shape.level) : null, stream: shape.stream as never, arm: r.arm || null }))
    .filter(Boolean);

  async function submit() {
    setBusy(true);
    const res = await postSms<{ created: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> }>(
      "/classes/arms",
      {
        stage: shape.stage || null,
        level: shape.level ? Number(shape.level) : null,
        stream: shape.stream || null,
        arms: rows.map((r) => ({ arm: r.arm, supervisorId: r.supervisorId || null, homeRoomId: r.homeRoomId || null })),
      },
    );
    setBusy(false);
    if (!res.ok) { onDone(res.error ?? "Could not create the classes."); return; }
    const { created = [], skipped = [] } = res.data ?? {};
    // REPORTS WHAT IT DID NOT DO. "3 created" with three silently skipped is the
    // failure this codebase keeps recording; each skip names the class and why.
    onDone(
      `${created.length} class${created.length === 1 ? "" : "es"} created.` +
        (skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}` : ""),
    );
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add several arms at once
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm text-muted-foreground">
        Creates one class per arm using the Section, Year and Stream chosen above. A class teacher can be set now or later —
        the classes list below flags every class that still has none.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`arm-${i}`}>Arm</Label>
            <select id={`arm-${i}`} value={r.arm} className={sel}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, arm: e.target.value } : x)))}>
              {CLASS_ARMS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`sup-${i}`}>Class teacher</Label>
            <select id={`sup-${i}`} value={r.supervisorId} className={sel}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, supervisorId: e.target.value } : x)))}>
              <option value="">— assign later —</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`room-${i}`}>Base room</Label>
            <select id={`room-${i}`} value={r.homeRoomId} className={sel}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, homeRoomId: e.target.value } : x)))}>
              <option value="">— none —</option>
              {rooms.map((rm) => <option key={rm.id} value={rm.id}>{rm.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Will be called</Label>
            <p className="flex h-9 items-center rounded-md border border-dashed border-border px-3 text-sm font-medium">
              {preview[i] || "—"}
            </p>
          </div>
          {rows.length > 1 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </Button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline"
          disabled={rows.length >= CLASS_ARMS.length}
          onClick={() => setRows([...rows, { arm: CLASS_ARMS[rows.length] ?? "A", supervisorId: "", homeRoomId: "" }])}>
          Add another arm
        </Button>
        <Button type="button" size="sm" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? "Creating…" : `Create ${rows.length} classes`}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
