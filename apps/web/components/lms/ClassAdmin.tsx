"use client";

import type { IdNameDto, UserSummaryDto, Serialized } from "@sms/types";
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
  const [at, setAt] = React.useState({ classId: classes[0]?.id ?? "", teacherId: teachers[0]?.id ?? "" });
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
          onSubmit={async (e) => { e.preventDefault(); if (await post("/classes", { name: cls.name }, "Class created.")) setCls({ name: "" }); }}
          className="flex flex-wrap items-end gap-2"
        >
          {/* A class is a COHORT — its subjects are defined per class in
              "Subjects, teachers & progression" (the Subject catalog +
              class-subject-teacher offerings), not typed here. */}
          <div className="space-y-1.5"><Label htmlFor="cl-name">New class</Label><Input id="cl-name" value={cls.name} onChange={(e) => setCls({ name: e.target.value })} placeholder="JSS1A" required /></div>
          <Button type="submit" size="sm">Create class</Button>
        </form>

        <form
          onSubmit={async (e) => { e.preventDefault(); await post(`/classes/${at.classId}/teachers`, { teacherId: at.teacherId }, "Teacher assigned."); }}
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
