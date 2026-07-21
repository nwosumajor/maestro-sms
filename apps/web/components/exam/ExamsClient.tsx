"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ExamSittingDto, MyExamDto, Serialized } from "@sms/types";
import { sendSms, postSms } from "@/components/game/play-ui";
import { personLabel } from "@/lib/people";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

type Sitting = Serialized<ExamSittingDto>;
type MyExam = Serialized<MyExamDto>;

// Exam logistics. Staff (exam.manage) schedule sittings, auto-seat a class and
// roster invigilators; everyone sees their own exams / invigilation duties.
export function ExamsClient({
  canManage,
  sittings,
  myExams,
  myInvigilations,
  classes,
  staff,
}: {
  canManage: boolean;
  sittings: Sitting[];
  myExams: MyExam[];
  myInvigilations: MyExam[];
  classes: { id: string; name: string }[];
  staff: { id: string; name: string; roles?: string[] }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ title: "", subject: "", date: "", startsAt: "09:00", endsAt: "11:00", hall: "", capacity: "" });
  const [pick, setPick] = React.useState<Record<string, { classId?: string; staffId?: string }>>({});

  const run = async (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(ok);
      router.refresh();
    } else setMsg(res.error ?? "Failed.");
  };

  return (
    <div className="space-y-6">
      {(myExams.length > 0 || myInvigilations.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{myInvigilations.length > 0 ? "Your exams & duties" : "Your exams"}</CardTitle>
            <CardDescription>Hall, time and seat number for each upcoming exam.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {[...myExams, ...myInvigilations].map((e, i) => (
                  <tr key={`${e.title}-${e.date}-${i}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{shortDate(e.date)}</td>
                    <td className="px-4 py-2">
                      {e.title}
                      {e.subject ? <span className="text-muted-foreground"> · {e.subject}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{e.startsAt}–{e.endsAt} · {e.hall}</td>
                    <td className="px-4 py-2 text-right">
                      {e.seatNo > 0 ? (
                        <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-medium text-primary">
                          {e.studentName ? `${e.studentName} · ` : ""}Seat {e.seatNo}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{e.studentName}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Schedule a sitting</CardTitle>
            <CardDescription>A dated exam in a hall; seat a class and roster invigilators below.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <input placeholder="Title" className="w-40 rounded-md border bg-background p-1.5 text-sm" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input placeholder="Subject (optional)" className="w-36 rounded-md border bg-background p-1.5 text-sm" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
            <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
            <input placeholder="Hall" className="w-32 rounded-md border bg-background p-1.5 text-sm" value={form.hall} onChange={(e) => setForm({ ...form, hall: e.target.value })} />
            <input type="number" min="0" placeholder="Seats" className="w-24 rounded-md border bg-background p-1.5 text-sm" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            <Button
              size="sm"
              disabled={busy || !form.title || !form.date || !form.hall}
              onClick={() =>
                run(
                  () =>
                    postSms("exams", {
                      title: form.title,
                      subject: form.subject || undefined,
                      date: form.date,
                      startsAt: form.startsAt,
                      endsAt: form.endsAt,
                      hall: form.hall,
                      capacity: form.capacity ? Number(form.capacity) : undefined,
                    }),
                  "Sitting scheduled.",
                )
              }
            >
              Schedule
            </Button>
          </CardContent>
        </Card>
      )}

      {canManage && sittings.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Sittings</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {sittings.map((s) => (
              <div key={s.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {s.title}
                      {s.subject ? <span className="text-muted-foreground"> · {s.subject}</span> : null}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {shortDate(s.date)} · {s.startsAt}–{s.endsAt} · {s.hall}
                      {s.capacity > 0 ? ` · ${s.seated}/${s.capacity} seated` : ` · ${s.seated} seated`} · {s.invigilators} invigilator(s)
                    </p>
                  </div>
                  <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => run(() => sendSms("DELETE", `exams/${s.id}`), "Sitting removed.")}>
                    remove
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select className="rounded-md border bg-background p-1 text-xs" value={pick[s.id]?.classId ?? ""} onChange={(e) => setPick({ ...pick, [s.id]: { ...pick[s.id], classId: e.target.value } })}>
                    <option value="">Seat a class…</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <Button size="sm" variant="outline" disabled={busy || !pick[s.id]?.classId} onClick={() => run(() => postSms(`exams/${s.id}/seats`, { classId: pick[s.id]!.classId }), "Seating assigned.")}>
                    Seat
                  </Button>
                  <select className="rounded-md border bg-background p-1 text-xs" value={pick[s.id]?.staffId ?? ""} onChange={(e) => setPick({ ...pick, [s.id]: { ...pick[s.id], staffId: e.target.value } })}>
                    <option value="">Add invigilator…</option>
                    {staff.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
                  </select>
                  <Button size="sm" variant="outline" disabled={busy || !pick[s.id]?.staffId} onClick={() => run(() => postSms(`exams/${s.id}/invigilators`, { staffId: pick[s.id]!.staffId }), "Invigilator assigned.")}>
                    Assign
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
