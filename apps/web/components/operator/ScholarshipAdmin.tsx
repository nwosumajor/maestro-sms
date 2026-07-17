"use client";

// Platform-owner scholarship console (super_admin): create/fund programs and
// review + award applications across ALL schools. Program writes and awards are
// step-up gated (money); review moves are not. Self-contained client island —
// loads its own data via the BFF.

import type { ScholarshipProgramDto, ScholarshipApplicationDto, Serialized } from "@sms/types";
import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { sendSms } from "@/components/game/play-ui";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Program = Serialized<ScholarshipProgramDto>;
type Application = Serialized<ScholarshipApplicationDto>;

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const nairaToKobo = (naira: string) => Math.round((parseFloat(naira) || 0) * 100);

export function ScholarshipAdmin() {
  const [programs, setPrograms] = React.useState<Program[]>([]);
  const [apps, setApps] = React.useState<Application[]>([]);
  const [statusFilter, setStatusFilter] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  // create-program form
  const [f, setF] = React.useState({ title: "", description: "", award: "", award2: "", award3: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL" });
  // per-application award position choice
  const [awardPos, setAwardPos] = React.useState<Record<string, number>>({});

  const loadPrograms = React.useCallback(async () => {
    const res = await fetch("/api/sms/scholarships/programs");
    if (res.ok) setPrograms((await res.json()) as Program[]);
  }, []);
  const loadApps = React.useCallback(async () => {
    const qs = statusFilter ? `?status=${statusFilter}` : "";
    const res = await fetch(`/api/sms/scholarships/applications${qs}`);
    if (res.ok) setApps((await res.json()) as Application[]);
  }, [statusFilter]);

  React.useEffect(() => { void loadPrograms(); }, [loadPrograms]);
  React.useEffect(() => { void loadApps(); }, [loadApps]);

  const createProgram = async () => {
    if (!f.title || !f.award || !f.opensAt || !f.closesAt) { setMsg({ ok: false, text: "Fill in title, award, and both dates." }); return; }
    setBusy("create"); setMsg(null);
    const res = await sendWithStepUp("POST", "scholarships/programs", {
      title: f.title,
      description: f.description || null,
      awardMinor: nairaToKobo(f.award),
      award2Minor: f.award2 ? nairaToKobo(f.award2) : null,
      award3Minor: f.award3 ? nairaToKobo(f.award3) : null,
      budgetMinor: nairaToKobo(f.budget),
      selectionBasis: f.basis,
      opensAt: new Date(f.opensAt).toISOString(),
      closesAt: new Date(f.closesAt).toISOString(),
      status: "OPEN",
      category: f.category,
    });
    setBusy(null);
    if (res.ok) {
      setMsg({ ok: true, text: "Program created and opened for applications." });
      setF({ title: "", description: "", award: "", award2: "", award3: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL" });
      void loadPrograms();
    } else setMsg({ ok: false, text: await readApiError(res) });
  };

  const setProgramStatus = async (id: string, status: string) => {
    setBusy(`prog-${id}`); setMsg(null);
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { status });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Program ${status.toLowerCase()}.` }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  const review = async (id: string, action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT") => {
    setBusy(`rev-${id}`); setMsg(null);
    const res = await sendSms("POST", `scholarships/applications/${id}/review`, { action });
    setBusy(null);
    if (res.ok) {
      setMsg({ ok: true, text: action === "QUALIFY" ? "Qualified — the student and guardians have been notified." : `Marked ${action.toLowerCase()}.` });
      void loadApps();
    } else setMsg({ ok: false, text: res.error ?? "Failed." });
  };

  const saveExam = async (id: string, v: { mode: string; at: string; venue: string; duration: string }) => {
    if (!v.mode || !v.at) { setMsg({ ok: false, text: "Pick an exam mode and date first." }); return; }
    setBusy(`exam-${id}`); setMsg(null);
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, {
      examMode: v.mode,
      examAt: new Date(v.at).toISOString(),
      examVenue: v.venue || null,
      examDurationMin: v.duration ? Math.max(1, parseInt(v.duration, 10)) : undefined,
    });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Exam details saved — add questions (CBT) then announce." }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  // Append one CBT question. The API stores the FULL set on the program; we send
  // the existing count + the new one by re-reading the program's current set.
  const addQuestion = async (id: string, q: { text: string; options: string[]; answerIndex: number }) => {
    setBusy(`q-${id}`); setMsg(null);
    // Fetch current questions is not exposed (answers are server-only); instead
    // the API PUT MERGES when given `appendQuestion`. Send the single question.
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { appendQuestion: q });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Question added." }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  const announceExam = async (id: string) => {
    setBusy(`announce-${id}`); setMsg(null);
    const res = await sendSms<{ notified: number; cbtExams: number; arena: boolean }>("POST", `scholarships/programs/${id}/announce-exam`);
    setBusy(null);
    if (res.ok) {
      const d = res.data;
      const surface = d?.cbtExams ? ` · ${d.cbtExams} CBT exam(s) published` : d?.arena ? " · games arena opened" : "";
      setMsg({ ok: true, text: `Exam announced to ${d?.notified ?? 0} qualified candidate(s)${surface}.` });
    } else setMsg({ ok: false, text: res.error ?? "Failed." });
  };

  const collectResults = async (id: string) => {
    setBusy(`collect-${id}`); setMsg(null);
    const res = await sendSms<{ updated: number }>("POST", `scholarships/programs/${id}/collect-results`);
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Pulled exam scores for ${res.data?.updated ?? 0} candidate(s). Rank them below and award the best three.` }); void loadApps(); }
    else setMsg({ ok: false, text: res.error ?? "Failed." });
  };

  const award = async (a: Application) => {
    const pos = awardPos[a.id] ?? 1;
    const posLabel = pos === 1 ? "1st" : pos === 2 ? "2nd" : "3rd";
    const prog = programs.find((pr) => pr.id === a.programId);
    const amount = pos === 3 ? (prog?.award3Minor ?? a.awardMinorOffered) : pos === 2 ? (prog?.award2Minor ?? a.awardMinorOffered) : a.awardMinorOffered;
    if (!confirm(`Award ${posLabel} position (${money(amount)}) to ${a.studentName} (${a.schoolName})? A fees credit is posted to their invoice.`)) return;
    setBusy(`award-${a.id}`); setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/applications/${a.id}/award`, { position: pos });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Awarded ${posLabel} position — fees credit disbursed to ${a.studentName}.` }); void loadApps(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scholarships (platform-sponsored)</CardTitle>
        <CardDescription>
          Create programs and review applications from every school. Awarding disburses a fees credit to the student.
          Program changes and awards need step-up re-auth.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {msg && (
          <p className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-muted text-foreground" : "border border-destructive/40 bg-destructive/10 text-destructive"}`}>
            {msg.text}
          </p>
        )}

        {/* Create program */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">New program</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">Title</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="STEM Scholarship 2026" /></div>
            <div className="space-y-1"><Label className="text-xs">🥇 1st prize (₦)</Label><Input type="number" min={0} className="w-28" value={f.award} onChange={(e) => setF({ ...f, award: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs">🥈 2nd prize (₦)</Label><Input type="number" min={0} className="w-28" value={f.award2} onChange={(e) => setF({ ...f, award2: e.target.value })} placeholder="= 1st" /></div>
            <div className="space-y-1"><Label className="text-xs">🥉 3rd prize (₦)</Label><Input type="number" min={0} className="w-28" value={f.award3} onChange={(e) => setF({ ...f, award3: e.target.value })} placeholder="= 1st" /></div>
            <div className="space-y-1"><Label className="text-xs">Budget (₦)</Label><Input type="number" min={0} className="w-32" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></div>
            <div className="space-y-1">
              <Label className="text-xs">Basis</Label>
              <select value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} className={sel}>
                <option value="BOTH">Merit + need</option><option value="MERIT">Merit</option><option value="NEED">Need</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className={sel}>
                <option value="GENERAL_SCIENCE">General Science</option>
                <option value="ART">Art</option>
                <option value="COMMUNITY_DEVELOPMENT">Community Development</option>
                <option value="MATHEMATICS">Mathematics</option>
                <option value="SPECIAL">Special</option>
              </select>
            </div>
            <div className="space-y-1"><Label className="text-xs">Opens</Label><Input type="date" className="w-40" value={f.opensAt} onChange={(e) => setF({ ...f, opensAt: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs">Closes</Label><Input type="date" className="w-40" value={f.closesAt} onChange={(e) => setF({ ...f, closesAt: e.target.value })} /></div>
            <Button disabled={busy === "create"} onClick={createProgram}>Create & open</Button>
          </div>
          <div className="space-y-1"><Label className="text-xs">Description</Label><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Who it's for, criteria…" /></div>
        </div>

        {/* Programs list */}
        {programs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Programs</p>
            {programs.map((pr) => (
              <ProgramRow
                key={pr.id}
                pr={pr}
                busy={busy}
                onSaveExam={(v) => saveExam(pr.id, v)}
                onAddQuestion={(q) => addQuestion(pr.id, q)}
                onAnnounce={() => announceExam(pr.id)}
                onCollect={() => collectResults(pr.id)}
                onStatus={(st) => setProgramStatus(pr.id, st)}
              />
            ))}
          </div>
        )}

        {/* Review queue */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">Applications</p>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={sel}>
              <option value="">All (submitted)</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="SHORTLISTED">Shortlisted</option>
              <option value="QUALIFIED">Qualified (exam candidates)</option>
              <option value="AWARDED">Awarded</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          {apps.length === 0 && <p className="text-sm text-muted-foreground">No applications match.</p>}
          {/* When viewing QUALIFIED candidates, rank by exam score so the best
              three are obvious before awarding by position. */}
          <div className="space-y-2">
            {[...apps]
              .sort((x, y) => (statusFilter === "QUALIFIED" ? (y.examScorePct ?? -1) - (x.examScorePct ?? -1) : 0))
              .map((a, idx) => {
                const s = a.signals;
                const finalised = a.status === "AWARDED" || a.status === "REJECTED";
                const rankingByScore = statusFilter === "QUALIFIED" && a.examScorePct != null;
                const pos = awardPos[a.id] ?? 1;
                return (
                  <div key={a.id} className="rounded-md border border-border/70 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {rankingByScore && <span className="mr-1 font-semibold text-primary">#{idx + 1}</span>}
                        <span className="font-medium">{a.studentName}</span>
                        <span className="text-muted-foreground"> · {a.schoolName} · {a.programTitle}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {a.examScorePct != null && <Badge variant="outline">exam {a.examScorePct}%</Badge>}
                        <Badge variant={a.status === "AWARDED" ? "default" : a.status === "REJECTED" ? "destructive" : "secondary"}>{a.status.replace(/_/g, " ")}</Badge>
                      </span>
                    </div>
                    {s && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Signals — avg: <strong>{s.publishedSessionAverage ?? "—"}</strong> · attendance: <strong>{s.attendanceRatePct ?? "—"}%</strong> · outstanding fees: <strong>{money(s.outstandingFeesMinor)}</strong>
                        {s.disciplineComplaints != null && <> · discipline: <strong>{s.disciplineComplaints}</strong></>}
                        {s.tasksCompleted != null && <> · tasks done: <strong>{s.tasksCompleted}</strong></>}
                        {" "}<span className="italic">(for judgement only, not a verdict)</span>
                      </p>
                    )}
                    {!finalised && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <Button size="sm" variant="ghost" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "REVIEW")}>Reviewing</Button>
                        <Button size="sm" variant="ghost" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "SHORTLIST")}>Shortlist</Button>
                        {a.status !== "QUALIFIED" && (
                          <Button size="sm" variant="outline" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "QUALIFY")}>
                            Qualify for exam
                          </Button>
                        )}
                        {/* Position picker + award — each position granted once. */}
                        <select
                          aria-label="Award position"
                          value={pos}
                          onChange={(e) => setAwardPos((m) => ({ ...m, [a.id]: Number(e.target.value) }))}
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        >
                          <option value={1}>🥇 1st</option>
                          <option value={2}>🥈 2nd</option>
                          <option value={3}>🥉 3rd</option>
                        </select>
                        <Button size="sm" disabled={busy === `award-${a.id}`} onClick={() => award(a)}>Award</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "REJECT")}>Reject</Button>
                      </div>
                    )}
                    {a.status === "AWARDED" && a.awardMinor != null && (
                      <p className="mt-1 text-xs text-primary">
                        {a.awardPosition ? `${a.awardPosition === 1 ? "🥇 1st" : a.awardPosition === 2 ? "🥈 2nd" : "🥉 3rd"} place — ` : ""}
                        Awarded {money(a.awardMinor)} · fees credit posted.
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// One program row: status controls + the qualification-exam pipeline (mode /
// date / duration / venue → save; CBT question composer; announce → collect
// results). Self-contained local state so the parent stays simple.
function ProgramRow({
  pr,
  busy,
  onSaveExam,
  onAddQuestion,
  onAnnounce,
  onCollect,
  onStatus,
}: {
  pr: Program;
  busy: string | null;
  onSaveExam: (v: { mode: string; at: string; venue: string; duration: string }) => void;
  onAddQuestion: (q: { text: string; options: string[]; answerIndex: number }) => void;
  onAnnounce: () => void;
  onCollect: () => void;
  onStatus: (status: string) => void;
}) {
  const [mode, setMode] = React.useState(pr.examMode ?? "");
  const [at, setAt] = React.useState("");
  const [venue, setVenue] = React.useState(pr.examVenue ?? "");
  const [duration, setDuration] = React.useState(String(pr.examDurationMin));
  const [showQ, setShowQ] = React.useState(false);
  const [q, setQ] = React.useState({ text: "", a: "", b: "", c: "", d: "", answer: 0 });

  const addQ = () => {
    const options = [q.a, q.b, q.c, q.d].map((o) => o.trim()).filter(Boolean);
    if (!q.text.trim() || options.length < 2) return;
    onAddQuestion({ text: q.text.trim(), options, answerIndex: Math.min(q.answer, options.length - 1) });
    setQ({ text: "", a: "", b: "", c: "", d: "", answer: 0 });
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium">{pr.title}</span>{" "}
          <span className="text-muted-foreground">
            🥇{money(pr.awardMinor)} 🥈{money(pr.award2Minor ?? pr.awardMinor)} 🥉{money(pr.award3Minor ?? pr.awardMinor)}
          </span>{" "}
          <Badge variant="outline">{String(pr.category).replaceAll("_", " ").toLowerCase()}</Badge>{" "}
          <Badge variant={pr.status === "OPEN" ? "secondary" : "outline"}>{pr.status}</Badge>
          {pr.examMode && pr.examAt && (
            <span className="ml-1 text-xs text-muted-foreground">
              exam: {pr.examMode.replaceAll("_", " ").toLowerCase()} · {shortDate(pr.examAt)}
              {pr.examMode === "ONLINE_CBT" && ` · ${pr.examQuestionCount} Qs · ${pr.examDurationMin}min`}
            </span>
          )}
        </span>
        <span className="flex gap-1">
          {pr.status !== "OPEN" && <Button size="sm" variant="outline" disabled={busy === `prog-${pr.id}`} onClick={() => onStatus("OPEN")}>Open</Button>}
          {pr.status === "OPEN" && <Button size="sm" variant="outline" disabled={busy === `prog-${pr.id}`} onClick={() => onStatus("CLOSED")}>Close</Button>}
        </span>
      </div>

      {/* Qualification exam scheduling */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Exam mode</Label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={sel}>
            <option value="">Select…</option>
            <option value="ONLINE_CBT">Online CBT mock</option>
            <option value="GAMES">Games arena</option>
            <option value="PHYSICAL">Physical exam</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Exam date</Label>
          <Input type="datetime-local" className="w-52" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        {mode === "ONLINE_CBT" && (
          <div className="space-y-1">
            <Label className="text-xs">Duration (min)</Label>
            <Input type="number" min={1} className="w-24" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Venue / link</Label>
          <Input className="w-44" placeholder="Hall / platform note" value={venue} onChange={(e) => setVenue(e.target.value)} />
        </div>
        <Button size="sm" variant="outline" disabled={busy === `exam-${pr.id}`} onClick={() => onSaveExam({ mode, at, venue, duration })}>
          Save exam
        </Button>
        {pr.examMode === "ONLINE_CBT" && (
          <Button size="sm" variant="ghost" onClick={() => setShowQ((v) => !v)}>
            {showQ ? "Hide" : "Add"} questions ({pr.examQuestionCount})
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy === `announce-${pr.id}` || !(pr.examMode && pr.examAt) || (pr.examMode === "ONLINE_CBT" && pr.examQuestionCount === 0)}
          title={pr.examMode === "ONLINE_CBT" && pr.examQuestionCount === 0 ? "Add CBT questions first" : "Notify candidates + open the exam"}
          onClick={onAnnounce}
        >
          Announce &amp; open
        </Button>
        {(pr.examMode === "ONLINE_CBT" || pr.examMode === "GAMES") && (
          <Button size="sm" variant="outline" disabled={busy === `collect-${pr.id}`} onClick={onCollect}>
            Collect results
          </Button>
        )}
      </div>

      {/* CBT question composer */}
      {showQ && pr.examMode === "ONLINE_CBT" && (
        <div className="space-y-2 rounded-md border border-dashed border-border p-2">
          <Input placeholder="Question text" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            {(["a", "b", "c", "d"] as const).map((k, i) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name={`ans-${pr.id}`} checked={q.answer === i} onChange={() => setQ({ ...q, answer: i })} />
                <Input placeholder={`Option ${i + 1}${i < 2 ? " *" : ""}`} value={q[k]} onChange={(e) => setQ({ ...q, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy === `q-${pr.id}`} onClick={addQ}>Add question</Button>
            <span className="text-xs text-muted-foreground">Select the radio next to the correct option. Answers stay server-side.</span>
          </div>
        </div>
      )}
    </div>
  );
}
