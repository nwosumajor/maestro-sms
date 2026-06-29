"use client";

import type { ClassDto, SubjectDto, UserSummaryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Cls = Serialized<ClassDto>;
type Subj = Serialized<SubjectDto>;
type User = Serialized<UserSummaryDto>;

export function ClassSubjectsAdmin({
  classes,
  subjects,
  users,
}: {
  classes: Cls[];
  subjects: Subj[];
  users: User[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const teachers = users.filter((u) => u.roles.includes("teacher"));
  const staff = users; // any staff can supervise
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  const send = async (method: "POST" | "PUT", path: string, body: unknown, ok: string) => {
    const res = await fetch(`/api/sms${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setMsg(res.ok ? ok : `Failed (${res.status}).`);
    if (res.ok) router.refresh();
    return res.ok;
  };

  const [subj, setSubj] = React.useState({ name: "", code: "" });
  const [cs, setCs] = React.useState({
    classId: classes[0]?.id ?? "",
    subjectId: subjects[0]?.id ?? "",
    teacherId: teachers[0]?.id ?? "",
  });
  const [sup, setSup] = React.useState({ classId: classes[0]?.id ?? "", supervisorId: staff[0]?.id ?? "" });
  const [prog, setProg] = React.useState({ classId: classes[0]?.id ?? "", level: "", nextClassId: "", capacity: "" });

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
          onSubmit={async (e) => { e.preventDefault(); await send("POST", `/classes/${cs.classId}/subjects`, { subjectId: cs.subjectId, teacherId: cs.teacherId }, "Subject teacher assigned."); }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        >
          <Label className="w-full">Assign subject + teacher to a class</Label>
          <select aria-label="Class" value={cs.classId} onChange={(e) => setCs({ ...cs, classId: e.target.value })} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Subject" value={cs.subjectId} onChange={(e) => setCs({ ...cs, subjectId: e.target.value })} className={sel}>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Teacher" value={cs.teacherId} onChange={(e) => setCs({ ...cs, teacherId: e.target.value })} className={sel}>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={!cs.subjectId || !cs.teacherId}>Assign</Button>
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
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
