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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { personLabel } from "@/lib/people";

type Named = Serialized<IdNameDto>;
type User = Serialized<UserSummaryDto>;

export function ClassAdmin({
  classes,
  students = [],
  users,
}: {
  classes: Named[];
  students?: Named[];
  users: User[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const teachers = users.filter((u) => u.roles.includes("teacher"));
  // EVERY CLASS HAS A CLASS TEACHER. They take its register and answer for it,
  // so the class cannot be created without naming one — the API refuses, and a
  // form that let you try would just produce a 400.
  const [classTeacherId, setClassTeacherId] = React.useState("");
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

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
                supervisorId: classTeacherId,
                stage: shape.stage || null,
                level: shape.level ? Number(shape.level) : null,
                stream: shape.stream || null,
                arm: shape.arm || null,
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
            <Label htmlFor="cl-teacher">Class teacher</Label>
            <select
              id="cl-teacher"
              value={classTeacherId}
              onChange={(e) => setClassTeacherId(e.target.value)}
              className={sel}
              required
            >
              <option value="">— choose —</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Will be called</Label>
            <p className="flex h-9 items-center rounded-md border border-dashed border-border px-3 text-sm font-medium">
              {composed || "—"}
            </p>
          </div>
          <Button type="submit" size="sm" disabled={!composed || !classTeacherId}>Create class</Button>
        </form>

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
