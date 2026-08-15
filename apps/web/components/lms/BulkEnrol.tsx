"use client";

// Enrol many pupils into a class in one go.
//
// The endpoint existed and nothing called it: the admin enrolled a class of
// thirty one pupil at a time, thirty round trips and thirty capacity checks.
//
// Three things make this safe to press:
//   * pupils are STAGED first and shown as a list, so a bulk write is never a
//     surprise — you see exactly who is about to be enrolled and can drop any of
//     them before committing;
//   * already-enrolled pupils are skipped by the server rather than failing, so
//     re-running a roster import is safe, and the count is REPORTED rather than
//     folded into a cheerful "Done.";
//   * the picker SEARCHES rather than enumerating — this page deliberately does
//     not receive the whole roster, and a bulk form is no reason to start.

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { StudentPicker } from "@/components/people/StudentPicker";
import { readApiError } from "@/lib/api-error";

type Named = Serialized<IdNameDto>;
type Staged = { id: string; name: string };

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export function BulkEnrol({ classes, students = [] }: { classes: Named[]; students?: Named[] }) {
  const router = useRouter();
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [staged, setStaged] = React.useState<Staged[]>([]);
  const [pick, setPick] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (classes.length === 0) return null;

  const add = (id: string, student?: { id: string; name: string }) => {
    setPick("");
    if (!id) return;
    // Adding the same pupil twice is a slip, not an instruction.
    if (staged.some((s) => s.id === id)) {
      setMsg("That pupil is already on the list below.");
      return;
    }
    setMsg(null);
    setStaged((prev) => [...prev, { id, name: student?.name ?? "Pupil" }]);
  };

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/classes/${classId}/enrollments/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentIds: staged.map((s) => s.id) }),
    });
    setBusy(false);
    if (!res.ok) {
      // The server's refusals are the useful ones — a class at capacity says so
      // by name, and one unknown id refuses the whole batch rather than half
      // enrolling it.
      setMsg(await readApiError(res));
      return;
    }
    const out = (await res.json()) as { enrolled: number; skipped: number };
    // Say what happened. "skipped" here has exactly one meaning — already in
    // this class — so it can be said plainly.
    setMsg(
      out.enrolled === 0
        ? `Nobody new to enrol — all ${out.skipped} were already in this class.`
        : `Enrolled ${out.enrolled}.${out.skipped > 0 ? ` ${out.skipped} were already in this class.` : ""}`,
    );
    setStaged([]);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Enrol several pupils</CardTitle>
        <CardDescription>
          Build the list, check it, then enrol in one go. Pupils already in the class are skipped, so running it twice is
          safe.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
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
          <div className="w-64">
            <Label className="mb-1 block">Add pupil</Label>
            <StudentPicker value={pick} onChange={add} seed={students} placeholder="Search pupils…" />
          </div>
        </div>

        {staged.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {staged.length} pupil{staged.length === 1 ? "" : "s"} ready to enrol:
            </p>
            <div className="flex flex-wrap gap-1">
              {staged.map((s) => (
                <span key={s.id} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                  {s.name}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setStaged((prev) => prev.filter((x) => x.id !== s.id))}
                  >
                    ×<span className="sr-only">Remove {s.name}</span>
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || !classId} onClick={() => void submit()}>
                Enrol {staged.length}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setStaged([])}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
