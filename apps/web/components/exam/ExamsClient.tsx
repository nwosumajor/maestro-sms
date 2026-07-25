"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ExamScheduleDto, ExamSittingDto, MyExamDto, Serialized } from "@sms/types";
import { sendSms, postSms } from "@/components/game/play-ui";
import { personLabel } from "@/lib/people";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

type Sitting = Serialized<ExamSittingDto>;
type Schedule = Serialized<ExamScheduleDto>;
type MyExam = Serialized<MyExamDto>;

// Exam logistics + online CBT. Staff (exam.manage) build a term's SCHEDULE of
// sittings (each optionally backed by a CBT exam), submit it for head-teacher →
// principal approval, seat + invigilate; on the day an exam.release holder OPENS
// each exam for students. Everyone sees their own exams / invigilation duties.
export function ExamsClient({
  canManage,
  canRelease,
  sittings,
  myExams,
  myInvigilations,
  classes,
  staff,
  schedules,
  attachableExams,
}: {
  canManage: boolean;
  canRelease: boolean;
  sittings: Sitting[];
  myExams: MyExam[];
  myInvigilations: MyExam[];
  classes: { id: string; name: string }[];
  staff: { id: string; name: string; roles?: string[] }[];
  schedules: Schedule[];
  attachableExams: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ title: "", subject: "", date: "", startsAt: "09:00", endsAt: "11:00", hall: "", capacity: "", scheduleId: "", cbtExamId: "" });
  const [schedTitle, setSchedTitle] = React.useState("");
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
            <CardTitle className="text-base">Exam schedules</CardTitle>
            <CardDescription>Group a term&apos;s sittings, then submit the whole schedule for head-teacher → principal approval.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <input placeholder="Schedule title (e.g. First Term Exams)" className="w-64 rounded-md border bg-background p-1.5 text-sm" value={schedTitle} onChange={(e) => setSchedTitle(e.target.value)} />
              <Button size="sm" disabled={busy || !schedTitle} onClick={() => run(() => postSms("exams/schedules", { title: schedTitle }), "Schedule created.").then(() => setSchedTitle(""))}>New schedule</Button>
            </div>
            {schedules.length > 0 && (
              <div className="space-y-1.5">
                {schedules.map((sc) => (
                  <div key={sc.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{sc.title}</span>{" "}
                      <span className="text-xs text-muted-foreground">{sc.sittingCount} sitting(s) · {sc.cbtCount} online</span>{" "}
                      <Badge variant={sc.status === "APPROVED" ? "default" : sc.status === "PENDING_REVIEW" ? "secondary" : "outline"}>{sc.status.replace("_", " ").toLowerCase()}</Badge>
                    </span>
                    {sc.status === "DRAFT" && (
                      <Button size="sm" variant="outline" disabled={busy || sc.sittingCount === 0} onClick={() => run(() => postSms(`exams/schedules/${sc.id}/submit`, {}), "Submitted for approval.")}>
                        Submit for approval
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Schedule a sitting</CardTitle>
            <CardDescription>A dated exam in a hall; optionally into a schedule and backed by an online CBT exam. Seat + invigilate below.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <input placeholder="Title" className="w-40 rounded-md border bg-background p-1.5 text-sm" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input placeholder="Subject (optional)" className="w-36 rounded-md border bg-background p-1.5 text-sm" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
            <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
            <input placeholder="Hall" className="w-32 rounded-md border bg-background p-1.5 text-sm" value={form.hall} onChange={(e) => setForm({ ...form, hall: e.target.value })} />
            <input type="number" min="0" placeholder="Seats" className="w-24 rounded-md border bg-background p-1.5 text-sm" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            <select className="rounded-md border bg-background p-1.5 text-sm" value={form.scheduleId} onChange={(e) => setForm({ ...form, scheduleId: e.target.value })}>
              <option value="">No schedule</option>
              {schedules.filter((sc) => sc.status === "DRAFT").map((sc) => <option key={sc.id} value={sc.id}>{sc.title}</option>)}
            </select>
            <select className="rounded-md border bg-background p-1.5 text-sm" value={form.cbtExamId} onChange={(e) => setForm({ ...form, cbtExamId: e.target.value })}>
              <option value="">Paper (no CBT)</option>
              {attachableExams.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
            </select>
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
                      scheduleId: form.scheduleId || undefined,
                      cbtExamId: form.cbtExamId || undefined,
                    }),
                  "Sitting scheduled.",
                ).then(() => setForm({ ...form, title: "", subject: "", cbtExamId: "" }))
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
                    {s.cbtExamId && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {s.released
                          ? <Badge variant="default">Released</Badge>
                          : <Badge variant={s.cbtStatus === "PUBLISHED" ? "secondary" : "outline"}>{(s.cbtStatus ?? "").replace("_", " ").toLowerCase() || "online"}</Badge>}
                        {s.released && <span className="text-xs text-muted-foreground">{s.submitted}/{s.started} submitted</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {canRelease && s.cbtExamId && s.cbtStatus === "PUBLISHED" && !s.released && (
                      <Button size="sm" disabled={busy} onClick={() => run(() => postSms(`exams/${s.id}/release`, {}), "Exam released — students can sit now.")}>
                        Release
                      </Button>
                    )}
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => run(() => sendSms("DELETE", `exams/${s.id}`), "Sitting removed.")}>
                      remove
                    </button>
                  </div>
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
