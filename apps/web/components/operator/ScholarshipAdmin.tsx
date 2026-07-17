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
  const [f, setF] = React.useState({ title: "", description: "", award: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL" });
  const [exam, setExam] = React.useState<Record<string, { mode: string; at: string; venue: string }>>({});

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
      setF({ title: "", description: "", award: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL" });
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

  const setExamDetails = async (id: string) => {
    const e = exam[id];
    if (!e?.mode || !e?.at) { setMsg({ ok: false, text: "Pick an exam mode and date first." }); return; }
    setBusy(`exam-${id}`); setMsg(null);
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, {
      examMode: e.mode,
      examAt: new Date(e.at).toISOString(),
      examVenue: e.venue || null,
    });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Exam details saved — announce when ready." }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  const announceExam = async (id: string) => {
    setBusy(`announce-${id}`); setMsg(null);
    const res = await sendSms<{ notified: number }>("POST", `scholarships/programs/${id}/announce-exam`);
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Exam announced to ${res.data?.notified ?? 0} qualified candidate(s) and their guardians.` }); }
    else setMsg({ ok: false, text: res.error ?? "Failed." });
  };

  const award = async (a: Application) => {
    if (!confirm(`Award ${money(a.awardMinorOffered)} to ${a.studentName} (${a.schoolName})? A fees credit is posted to their invoice.`)) return;
    setBusy(`award-${a.id}`); setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/applications/${a.id}/award`, {});
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Awarded — fees credit disbursed to ${a.studentName}.` }); void loadApps(); }
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
            <div className="space-y-1"><Label className="text-xs">Award (₦)</Label><Input type="number" min={0} className="w-28" value={f.award} onChange={(e) => setF({ ...f, award: e.target.value })} /></div>
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
              <div key={pr.id} className="space-y-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{pr.title}</span> · {money(pr.awardMinor)} · closes {shortDate(pr.closesAt)}{" "}
                    <Badge variant="outline">{String(pr.category).replaceAll("_", " ").toLowerCase()}</Badge>{" "}
                    <Badge variant={pr.status === "OPEN" ? "secondary" : "outline"}>{pr.status}</Badge>
                    {pr.examMode && pr.examAt && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        exam: {pr.examMode.replaceAll("_", " ").toLowerCase()} · {shortDate(pr.examAt)}
                      </span>
                    )}
                  </span>
                  <span className="flex gap-1">
                    {pr.status !== "OPEN" && <Button size="sm" variant="outline" disabled={busy === `prog-${pr.id}`} onClick={() => setProgramStatus(pr.id, "OPEN")}>Open</Button>}
                    {pr.status === "OPEN" && <Button size="sm" variant="outline" disabled={busy === `prog-${pr.id}`} onClick={() => setProgramStatus(pr.id, "CLOSED")}>Close</Button>}
                  </span>
                </div>
                {/* Qualification exam: pick mode + date (+ venue), save, then announce to all QUALIFIED candidates. */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Exam mode</Label>
                    <select
                      value={exam[pr.id]?.mode ?? pr.examMode ?? ""}
                      onChange={(e) => setExam((s) => ({ ...s, [pr.id]: { mode: e.target.value, at: s[pr.id]?.at ?? "", venue: s[pr.id]?.venue ?? "" } }))}
                      className={sel}
                    >
                      <option value="">Select…</option>
                      <option value="ONLINE_CBT">Online CBT mock</option>
                      <option value="GAMES">Games arena</option>
                      <option value="PHYSICAL">Physical exam</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Exam date</Label>
                    <Input
                      type="datetime-local"
                      className="w-52"
                      value={exam[pr.id]?.at ?? ""}
                      onChange={(e) => setExam((s) => ({ ...s, [pr.id]: { mode: s[pr.id]?.mode ?? pr.examMode ?? "", at: e.target.value, venue: s[pr.id]?.venue ?? "" } }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Venue / link</Label>
                    <Input
                      className="w-48"
                      placeholder="Hall / platform note"
                      value={exam[pr.id]?.venue ?? pr.examVenue ?? ""}
                      onChange={(e) => setExam((s) => ({ ...s, [pr.id]: { mode: s[pr.id]?.mode ?? pr.examMode ?? "", at: s[pr.id]?.at ?? "", venue: e.target.value } }))}
                    />
                  </div>
                  <Button size="sm" variant="outline" disabled={busy === `exam-${pr.id}`} onClick={() => setExamDetails(pr.id)}>
                    Save exam
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === `announce-${pr.id}` || !(pr.examMode && pr.examAt)}
                    title={pr.examMode && pr.examAt ? "Notify every qualified candidate + guardians" : "Save the exam mode and date first"}
                    onClick={() => announceExam(pr.id)}
                  >
                    Announce exam
                  </Button>
                </div>
              </div>
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
          <div className="space-y-2">
            {apps.map((a) => {
              const s = a.signals;
              const finalised = a.status === "AWARDED" || a.status === "REJECTED";
              return (
                <div key={a.id} className="rounded-md border border-border/70 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{a.studentName}</span>
                      <span className="text-muted-foreground"> · {a.schoolName} · {a.programTitle}</span>
                    </span>
                    <Badge variant={a.status === "AWARDED" ? "default" : a.status === "REJECTED" ? "destructive" : "secondary"}>{a.status.replace(/_/g, " ")}</Badge>
                  </div>
                  {s && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Signals — avg: <strong>{s.publishedSessionAverage ?? "—"}</strong> · attendance: <strong>{s.attendanceRatePct ?? "—"}%</strong> · outstanding fees: <strong>{money(s.outstandingFeesMinor)}</strong>
                      {" "}<span className="italic">(for judgement only, not a verdict)</span>
                    </p>
                  )}
                  {!finalised && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "REVIEW")}>Reviewing</Button>
                      <Button size="sm" variant="ghost" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "SHORTLIST")}>Shortlist</Button>
                      {a.status !== "QUALIFIED" && (
                        <Button size="sm" variant="outline" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "QUALIFY")}>
                          Qualify for exam
                        </Button>
                      )}
                      <Button size="sm" disabled={busy === `award-${a.id}`} onClick={() => award(a)}>Award {money(a.awardMinorOffered)}</Button>
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === `rev-${a.id}`} onClick={() => review(a.id, "REJECT")}>Reject</Button>
                    </div>
                  )}
                  {a.status === "AWARDED" && a.awardMinor != null && (
                    <p className="mt-1 text-xs text-primary">Awarded {money(a.awardMinor)} — fees credit posted.</p>
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
