"use client";

import type { ClassDto, SubjectDto, UserSummaryDto, Serialized } from "@sms/types";
import { interpretApiError } from "@/lib/api-error";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { personLabel } from "@/lib/people";

type Cls = Serialized<ClassDto>;
type Subj = Serialized<SubjectDto>;
type User = Serialized<UserSummaryDto>;

export function ClassSubjectsAdmin({
  classes,
  subjects,
  users,
  rooms,
}: {
  classes: Cls[];
  subjects: Subj[];
  users: User[];
  /** Room directory for the offering's fixed-room (CSP) input; [] hides it. */
  rooms: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const teachers = users.filter((u) => u.roles.includes("teacher"));
  // The class supervisor is the FORM TEACHER — pick from teachers only, never
  // the mixed school directory (students/parents must not appear here).
  const staff = teachers;
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  const send = async (method: "POST" | "PUT" | "DELETE", path: string, body: unknown, ok: string) => {
    const res = await fetch(`/api/sms${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) {
      setMsg(ok);
      router.refresh();
    } else {
      // Surface the API's message (e.g. why a class can't be deleted).
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string | string[] };
        detail = Array.isArray(j.message) ? j.message.join(", ") : j.message ?? "";
      } catch { /* ignore */ }
      setMsg(interpretApiError(res.status, detail || null));
    }
    return res.ok;
  };

  const [subj, setSubj] = React.useState({ name: "", code: "" });
  const [cs, setCs] = React.useState({
    classId: classes[0]?.id ?? "",
    subjectId: subjects[0]?.id ?? "",
    teacherId: teachers[0]?.id ?? "",
    lessonsPerWeek: "",
    preferredRoomId: "",
  });
  const [sup, setSup] = React.useState({ classId: classes[0]?.id ?? "", supervisorId: staff[0]?.id ?? "" });
  const [prog, setProg] = React.useState({ classId: classes[0]?.id ?? "", level: "", nextClassId: "", capacity: "" });
  const [manage, setManage] = React.useState({ classId: classes[0]?.id ?? "", newName: "" });
  const [subjFix, setSubjFix] = React.useState({ subjectId: subjects[0]?.id ?? "", newName: "" });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Subjects, teachers &amp; progression</CardTitle>
        <CardDescription>
          Build the subject catalog, assign a teacher per class-subject, set a class supervisor, and define the
          class level + the class students promote into.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create subject */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await send("POST", "/subjects", { name: subj.name, code: subj.code || undefined }, "Subject created."))
              setSubj({ name: "", code: "" });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="space-y-1.5"><Label htmlFor="su-name">New subject</Label><Input id="su-name" value={subj.name} onChange={(e) => setSubj({ ...subj, name: e.target.value })} placeholder="Mathematics" required /></div>
          <div className="space-y-1.5"><Label htmlFor="su-code">Code</Label><Input id="su-code" value={subj.code} onChange={(e) => setSubj({ ...subj, code: e.target.value })} placeholder="MTH" className="w-24" /></div>
          <Button type="submit" size="sm">Add subject</Button>
        </form>

        {/* Assign subject + teacher to a class */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await send("POST", `/classes/${cs.classId}/subjects`, {
              subjectId: cs.subjectId,
              teacherId: cs.teacherId,
              // CSP timetable inputs — omitted when blank so re-assigning a
              // teacher never silently resets a stored quota/room.
              ...(cs.lessonsPerWeek !== "" ? { lessonsPerWeek: Number(cs.lessonsPerWeek) } : {}),
              ...(cs.preferredRoomId !== "" ? { preferredRoomId: cs.preferredRoomId } : {}),
            }, "Subject teacher assigned.");
          }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Assign subject + teacher to a class</Label>
          <p className="w-full text-xs text-muted-foreground">
            Lessons/week and a fixed room feed the timetable auto-generator (leave blank to keep the
            stored values — the quota defaults to 2).
          </p>
          <select aria-label="Class" value={cs.classId} onChange={(e) => setCs({ ...cs, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Subject" value={cs.subjectId} onChange={(e) => setCs({ ...cs, subjectId: e.target.value })} className={sel}>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Teacher" value={cs.teacherId} onChange={(e) => setCs({ ...cs, teacherId: e.target.value })} className={sel}>
            {teachers.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
          </select>
          <Input
            aria-label="Lessons per week"
            type="number"
            min={1}
            max={15}
            value={cs.lessonsPerWeek}
            onChange={(e) => setCs({ ...cs, lessonsPerWeek: e.target.value })}
            placeholder="Lessons/wk"
            className="w-28"
          />
          {rooms.length > 0 && (
            <select aria-label="Fixed room" value={cs.preferredRoomId} onChange={(e) => setCs({ ...cs, preferredRoomId: e.target.value })} className={sel}>
              <option value="">Any room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={!cs.subjectId || !cs.teacherId}>Assign</Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!cs.classId || !cs.subjectId}
            onClick={async () => {
              await send("DELETE", `/classes/${cs.classId}/subjects/${cs.subjectId}`, undefined, "Offering removed.");
            }}
          >
            Remove offering
          </Button>
        </form>

        {/* Class supervisor */}
        <form
          onSubmit={async (e) => { e.preventDefault(); await send("PUT", `/classes/${sup.classId}`, { supervisorId: sup.supervisorId }, "Supervisor set."); }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Class supervisor (form teacher)</Label>
          <select aria-label="Class" value={sup.classId} onChange={(e) => setSup({ ...sup, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Supervisor" value={sup.supervisorId} onChange={(e) => setSup({ ...sup, supervisorId: e.target.value })} className={sel}>
            {staff.map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={!sup.supervisorId}>Set supervisor</Button>
        </form>

        {/* Class progression: level + next class */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await send("PUT", `/classes/${prog.classId}`, {
              level: prog.level === "" ? null : Number(prog.level),
              nextClassId: prog.nextClassId || null,
              capacity: prog.capacity === "" ? null : Number(prog.capacity),
            }, "Progression updated.");
          }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Class progression &amp; capacity</Label>
          <select aria-label="Class" value={prog.classId} onChange={(e) => setProg({ ...prog, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input aria-label="Level" type="number" value={prog.level} onChange={(e) => setProg({ ...prog, level: e.target.value })} placeholder="Level" className="w-20" />
          <select aria-label="Next class" value={prog.nextClassId} onChange={(e) => setProg({ ...prog, nextClassId: e.target.value })} className={sel}>
            <option value="">— final class (graduates) —</option>
            {classes.filter((c) => c.id !== prog.classId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input aria-label="Capacity" type="number" value={prog.capacity} onChange={(e) => setProg({ ...prog, capacity: e.target.value })} placeholder="Capacity" className="w-24" />
          <Button type="submit" size="sm" variant="outline">Save</Button>
        </form>

        {/* Fix a mistake: rename a class, or delete a duplicate created in error */}
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Label className="w-full">Rename or remove a class</Label>
          <select
            aria-label="Class to fix"
            value={manage.classId}
            onChange={(e) => setManage({ ...manage, classId: e.target.value })}
            className={sel}
          >
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input
            aria-label="New class name"
            value={manage.newName}
            onChange={(e) => setManage({ ...manage, newName: e.target.value })}
            placeholder="Correct class name"
            className="w-48"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!manage.classId || !manage.newName.trim()}
            onClick={async () => {
              if (await send("PUT", `/classes/${manage.classId}`, { name: manage.newName.trim() }, "Class renamed."))
                setManage({ ...manage, newName: "" });
            }}
          >
            Rename
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!manage.classId}
            onClick={async () => {
              const c = classes.find((x) => x.id === manage.classId);
              if (!confirm(`Delete the class "${c?.name ?? ""}"? This only works if it has no students, teachers, timetable or other data.`)) return;
              await send("DELETE", `/classes/${manage.classId}`, undefined, "Class deleted.");
            }}
          >
            Delete
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Deleting is allowed only for an EMPTY class (e.g. a duplicate). If it already has students, timetable or
            other data, rename it instead.
          </p>
        </div>

        {/* Rename / delete a SUBJECT (duplicate cleanup) */}
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Label className="w-full">Rename or remove a subject</Label>
          <select
            aria-label="Subject to fix"
            value={subjFix.subjectId}
            onChange={(e) => setSubjFix({ ...subjFix, subjectId: e.target.value })}
            className={sel}
          >
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}
          </select>
          <Input
            aria-label="New subject name"
            value={subjFix.newName}
            onChange={(e) => setSubjFix({ ...subjFix, newName: e.target.value })}
            placeholder="Correct subject name"
            className="w-48"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!subjFix.subjectId || !subjFix.newName.trim()}
            onClick={async () => {
              if (await send("PUT", `/subjects/${subjFix.subjectId}`, { name: subjFix.newName.trim() }, "Subject renamed."))
                setSubjFix({ ...subjFix, newName: "" });
            }}
          >
            Rename
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!subjFix.subjectId}
            onClick={async () => {
              const s = subjects.find((x) => x.id === subjFix.subjectId);
              if (!confirm(`Delete the subject "${s?.name ?? ""}"? This only works if no class offers it.`)) return;
              await send("DELETE", `/subjects/${subjFix.subjectId}`, undefined, "Subject deleted.");
            }}
          >
            Delete
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Deleting is allowed only for a subject no class offers (e.g. a duplicate). If classes already offer it,
            rename it instead — offerings follow the subject automatically.
          </p>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
