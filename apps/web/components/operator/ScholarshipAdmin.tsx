"use client";

// Platform-owner scholarship console (super_admin): create/fund programs and
// review + award applications across ALL schools. Program writes and awards are
// step-up gated (money); review moves are not. Self-contained client island —
// loads its own data via the BFF.

import type {
  ScholarshipExamQuestionDto,
  ScholarshipProgramDto,
  ScholarshipApplicationDto,
  ScholarshipApplicationPageDto,
  ScholarshipLibraryPageDto,
  ScholarshipSchoolSpreadDto,
  Serialized,
} from "@sms/types";

type Question = Serialized<ScholarshipExamQuestionDto>;
import { useFormat } from "@/components/shell/RegionProvider";
import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { sendSms } from "@/components/game/play-ui";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import { CURRENCIES, SCHOLARSHIP_SCHOOL_PRIZE_MONTHS, SCHOLARSHIP_SCHOOL_PRIZE_PLAN, toMinor } from "@sms/types";

type Program = Serialized<ScholarshipProgramDto>;
type Application = Serialized<ScholarshipApplicationDto>;

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
/**
 * A scholarship is sponsored by the PLATFORM, so its award is denominated in the
 * platform's own currency — not the recipient school's, which may be any of the
 * catalogue. Stated through the shared helper rather than a bare `* 100`, so the
 * assumption is visible and so this console cannot disagree with the API about
 * the scale of the number it is sending.
 */
// SCALED BY THE CURRENCY BEING AWARDED, not by naira. A hard-coded NGN here is
// correct for a two-decimal currency by accident and 100x wrong for a
// zero-decimal one — the writing half of the money rule, which this codebase
// has already been bitten by at fourteen sites.
const awardToMinor = (major: string, currency: string) => toMinor(parseFloat(major) || 0, currency);

/** The papers a programme has, derived from its questions — never a second list. */
function subjectsOf(paper: Question[]): string[] {
  return [...new Set(paper.map((q) => q.subject).filter((x): x is string => !!x))];
}

export function ScholarshipAdmin() {
  const [programs, setPrograms] = React.useState<Program[]>([]);
  const [apps, setApps] = React.useState<Application[]>([]);
  const [statusFilter, setStatusFilter] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  // create-program form
  const [f, setF] = React.useState({ title: "", description: "", award: "", award2: "", award3: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL", currency: CURRENCIES.NGN as string });
  // per-application award position choice
  const [awardPos, setAwardPos] = React.useState<Record<string, number>>({});
  const [appPage, setAppPage] = React.useState(1);
  const [appPageInfo, setAppPageInfo] = React.useState({
    total: 0,
    pageSize: 50,
    undecidedTotal: 0,
    hasMore: false,
    countCap: 10_000,
  });
  const [appsFailed, setAppsFailed] = React.useState(false);
  /** Rows ticked for a bulk decision. Cleared whenever the page or filter moves,
   *  so a tick made on page 1 can never be acted on from page 2. */
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  // The reusable question library. A programme's paper holds COPIES, so editing
  // here changes what future papers are built from and touches no paper already
  // built — which is what makes reuse safe.
  const [lib, setLib] = React.useState<Serialized<ScholarshipLibraryPageDto> | null>(null);
  const [libFailed, setLibFailed] = React.useState(false);
  const [libFilter, setLibFilter] = React.useState({ subject: "", q: "", page: 1 });
  const [libPicked, setLibPicked] = React.useState<Set<string>>(new Set());

  const loadPrograms = React.useCallback(async () => {
    const res = await fetch("/api/sms/scholarships/programs");
    if (res.ok) setPrograms((await res.json()) as Program[]);
  }, []);
  const loadApps = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (statusFilter) qs.set("status", statusFilter);
    if (appPage > 1) qs.set("page", String(appPage));
    const res = await fetch(`/api/sms/scholarships/applications?${qs.toString()}`);
    if (!res.ok) {
      // A failed read must not read as "nobody has applied" — that is a claim
      // about families waiting on a decision.
      setAppsFailed(true);
      return;
    }
    setAppsFailed(false);
    const page = (await res.json()) as Serialized<ScholarshipApplicationPageDto>;
    setApps(page.items);
    setPicked(new Set());
    setAppPageInfo({
      total: page.total,
      pageSize: page.pageSize,
      undecidedTotal: page.undecidedTotal,
      hasMore: page.hasMore,
      countCap: page.countCap,
    });
  }, [statusFilter, appPage]);

  React.useEffect(() => { void loadPrograms(); }, [loadPrograms]);
  React.useEffect(() => { void loadApps(); }, [loadApps]);

  const createProgram = async () => {
    if (!f.title || !f.award || !f.opensAt || !f.closesAt) { setMsg({ ok: false, text: "Fill in title, award, and both dates." }); return; }
    setBusy("create"); setMsg(null);
    const res = await sendWithStepUp("POST", "scholarships/programs", {
      title: f.title,
      description: f.description || null,
      awardMinor: awardToMinor(f.award, f.currency),
      award2Minor: f.award2 ? awardToMinor(f.award2, f.currency) : null,
      award3Minor: f.award3 ? awardToMinor(f.award3, f.currency) : null,
      budgetMinor: awardToMinor(f.budget, f.currency),
      awardCurrency: f.currency,
      selectionBasis: f.basis,
      opensAt: new Date(f.opensAt).toISOString(),
      closesAt: new Date(f.closesAt).toISOString(),
      status: "OPEN",
      category: f.category,
    });
    setBusy(null);
    if (res.ok) {
      setMsg({ ok: true, text: "Program created and opened for applications." });
      setF({ title: "", description: "", award: "", award2: "", award3: "", budget: "", basis: "BOTH", opensAt: "", closesAt: "", category: "SPECIAL", currency: CURRENCIES.NGN as string });
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

  const saveExam = async (
    id: string,
    v: { mode: string; at: string; venue: string; duration: string; cap: string },
  ) => {
    if (!v.mode || !v.at) { setMsg({ ok: false, text: "Pick an exam mode and date first." }); return; }
    setBusy(`exam-${id}`); setMsg(null);
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, {
      examMode: v.mode,
      examAt: new Date(v.at).toISOString(),
      examVenue: v.venue || null,
      examDurationMin: v.duration ? Math.max(1, parseInt(v.duration, 10)) : undefined,
      // Blank means NO CAP, and null is how that is expressed — sending 0 would
      // be a cap that qualifies nobody.
      maxCandidatesPerSchool: v.cap.trim() === "" ? null : Math.max(1, parseInt(v.cap, 10)),
    });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Exam details saved — add questions (CBT) then announce." }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  // Append one CBT question. The API stores the FULL set on the program; we send
  // the existing count + the new one by re-reading the program's current set.
  const addQuestion = async (
    id: string,
    q: { text: string; options: string[]; answerIndex: number; subject?: string | null },
  ) => {
    setBusy(`q-${id}`); setMsg(null);
    // Fetch current questions is not exposed (answers are server-only); instead
    // the API PUT MERGES when given `appendQuestion`. Send the single question.
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { appendQuestion: q });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Question added." }); void loadPrograms(); }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  /** The paper as written. `null` means the READ failed — not an empty paper. */
  const loadPaper = async (id: string): Promise<Question[] | null> => {
    const res = await fetch(`/api/sms/scholarships/programs/${id}/questions`);
    if (!res.ok) return null;
    return (await res.json()) as Question[];
  };

  /**
   * Remove one question by POSITION.
   *
   * The API's `examQuestions` REPLACES the set, which is what makes a removal
   * (or a correction) possible at all — `appendQuestion` alone could only ever
   * grow the paper. Re-reads first so a stale page cannot drop a question added
   * since it was opened.
   */
  const removeQuestion = async (id: string, index: number): Promise<boolean> => {
    setBusy(`q-${id}`); setMsg(null);
    const current = await loadPaper(id);
    if (current === null) {
      setBusy(null);
      setMsg({ ok: false, text: "The paper could not be read, so nothing was removed." });
      return false;
    }
    const kept = current
      .filter((question) => question.index !== index)
      // THE SUBJECT COMES BACK TOO. This replaces the whole set, so a field
      // dropped here is dropped from every question that survives — removing
      // ONE question would have collapsed a three-paper exam into one, silently
      // and on the operator's next click.
      .map(({ text, options, answerIndex, subject }) => ({ text, options, answerIndex, subject }));
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { examQuestions: kept });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: "Question removed." }); void loadPrograms(); return true; }
    setMsg({ ok: false, text: await readApiError(res) });
    return false;
  };

  const loadLibrary = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (libFilter.subject) qs.set("subject", libFilter.subject);
    if (libFilter.q) qs.set("q", libFilter.q);
    if (libFilter.page > 1) qs.set("page", String(libFilter.page));
    const res = await fetch(`/api/sms/scholarships/questions?${qs.toString()}`);
    if (!res.ok) {
      // A failed read must not read as "the library is empty" — that would
      // invite an owner to type questions they already have.
      setLibFailed(true);
      return;
    }
    setLibFailed(false);
    setLibPicked(new Set());
    setLib((await res.json()) as Serialized<ScholarshipLibraryPageDto>);
  }, [libFilter]);

  // Re-load when the filter or page moves, but ONLY while the library is open:
  // an operator who never opens it should not pay for a query.
  const libOpen = lib !== null || libFailed;
  React.useEffect(() => {
    if (libOpen) void loadLibrary();
  }, [libOpen, loadLibrary]);



  const copyLibraryTo = async (programId: string) => {
    const ids = [...libPicked];
    if (ids.length === 0) return;
    setBusy("lib");
    const res = await sendWithStepUp("POST", `scholarships/programs/${programId}/questions/copy`, { questionIds: ids });
    setBusy(null);
    if (!res.ok) {
      setMsg({ ok: false, text: await readApiError(res) });
      return;
    }
    const d = (await res.json().catch(() => null)) as { added?: number; skipped?: number } | null;
    // REPORT WHAT WAS NOT ADDED. A question already on the paper is a skip, not
    // a duplicate, and "added 3" over a selection of 5 reads as complete.
    setMsg({
      ok: true,
      text:
        `${d?.added ?? 0} question(s) added to the paper.` +
        ((d?.skipped ?? 0) > 0 ? ` ${d?.skipped} already on it.` : ""),
    });
    setLibPicked(new Set());
    void loadPrograms();
  };

  /**
   * Decide a whole selection at once.
   *
   * Qualifying a cohort one row at a time is 2,000 requests for a 5,000-applicant
   * programme, and the platform's own per-tenant limiter refuses about half of
   * them — measured, not predicted.
   */
  const decideSelected = async (action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT") => {
    const ids = [...picked];
    if (ids.length === 0) return;
    setBusy("bulk");
    setMsg(null);
    const res = await sendSms("POST", "scholarships/applications/decide-bulk", { ids, action });
    setBusy(null);
    if (!res.ok) {
      setMsg({ ok: false, text: res.error ?? "The decision could not be recorded." });
      return;
    }
    const d = res.data as { updated?: number; skipped?: Array<{ id: string; reason: string }> } | null;
    const skipped = d?.skipped ?? [];
    // REPORT WHAT WAS NOT DONE. "Qualified 497" over a selection of 500 reads as
    // complete, and the three left behind are the ones somebody has to chase.
    setMsg({
      ok: true,
      text:
        `${d?.updated ?? 0} application(s) moved to ${action.toLowerCase()}.` +
        (skipped.length > 0
          ? ` ${skipped.length} left unchanged — ${[...new Set(skipped.map((x) => x.reason))].join("; ")}.`
          : ""),
    });
    void loadApps();
  };

  /**
   * Record a physical exam's marks.
   *
   * The one mode with no sitting to harvest, and until now the one that could
   * be announced and never scored — so its candidates could never be ranked and
   * their schools could never win a prize on merit.
   */
  const recordScores = async (
    programId: string,
    marks: Array<{ applicationId: string; scorePct: number }>,
  ): Promise<boolean> => {
    // Checked HERE as well as at the boundary: a typo should be a sentence on
    // the sheet rather than a 400 after the round trip.
    if (marks.some((m) => !Number.isFinite(m.scorePct) || m.scorePct < 0 || m.scorePct > 100)) {
      setMsg({ ok: false, text: "A mark must be a number between 0 and 100. Nothing was recorded." });
      return false;
    }
    setBusy(`scores-${programId}`);
    setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/programs/${programId}/scores`, { marks });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json().catch(() => null)) as { updated?: number } | null;
      setMsg({ ok: true, text: `Recorded ${d?.updated ?? marks.length} mark(s). Rank the candidates to award.` });
      void loadApps();
      return true;
    }
    setMsg({ ok: false, text: await readApiError(res) });
    return false;
  };

  /**
   * Correct ONE question in place.
   *
   * The paper could be added to and removed from, and not EDITED — so fixing a
   * typo, or a wrong correct-option, meant deleting the question and typing it
   * again, which moves it to the end of the paper and loses its position.
   *
   * Re-reads first and carries every OTHER question back untouched, subject
   * included: `examQuestions` replaces the whole set, so a field dropped here
   * is dropped from every question that survives.
   */
  const editQuestion = async (
    id: string,
    index: number,
    next: { text: string; options: string[]; answerIndex: number; subject: string | null },
  ): Promise<boolean> => {
    setBusy(`q-${id}`);
    setMsg(null);
    const current = await loadPaper(id);
    if (current === null) {
      setBusy(null);
      setMsg({ ok: false, text: "The paper could not be read, so nothing was changed." });
      return false;
    }
    const examQuestions = current.map((question) =>
      question.index === index
        ? next
        : { text: question.text, options: question.options, answerIndex: question.answerIndex, subject: question.subject },
    );
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { examQuestions });
    setBusy(null);
    if (res.ok) {
      setMsg({ ok: true, text: "Question corrected." });
      void loadPrograms();
      return true;
    }
    setMsg({ ok: false, text: await readApiError(res) });
    return false;
  };

  /**
   * Publish (or withdraw) a programme's results to every school.
   *
   * The confirm names WHAT is published, because "publish results" alone does
   * not tell an operator whether a child is about to be named on a table every
   * tenant can read. It is school, position and score.
   */
  const publishResults = async (id: string, publish: boolean) => {
    if (
      publish &&
      !confirm(
        "Publish these results to EVERY school on the platform?\n\n" +
          "The table shows each candidate's SCHOOL, their position and their score. " +
          "No pupil is named.\n\nYou can withdraw it again afterwards.",
      )
    )
      return;
    setBusy(`pub-${id}`);
    setMsg(null);
    const res = await sendSms<{ rows: number }>("POST", `scholarships/programs/${id}/${publish ? "publish" : "unpublish"}-results`);
    setBusy(null);
    if (res.ok) {
      setMsg({
        ok: true,
        text: publish
          ? `Published — ${res.data?.rows ?? 0} scored candidate(s) are now visible to every school, by school and position.`
          : "Withdrawn — the table is no longer visible to any school.",
      });
      void loadPrograms();
      // `sendSms` already carries the server's message plus a plain-language
      // reading of the status — `readApiError` takes a raw Response, which this
      // is not. The compiler caught it, as it did the last time.
    } else setMsg({ ok: false, text: res.error ?? "Could not change the publication." });
  };

  /**
   * When one SUBJECT's paper opens.
   *
   * Sent as a MERGE of the existing schedule, not a replacement: setting the
   * English date must not clear the Maths one, and the PUT replaces the whole
   * map. Same shape as the question removal one panel up, and the same trap.
   */
  const saveWindow = async (
    id: string,
    current: Record<string, { examAt: string; durationMin?: number }>,
    subject: string,
    examAt: string,
    durationMin: number | null,
  ) => {
    setBusy(`sched-${id}`);
    setMsg(null);
    const next = { ...current };
    if (!examAt) delete next[subject];
    else next[subject] = { examAt: new Date(examAt).toISOString(), ...(durationMin ? { durationMin } : {}) };
    const res = await sendWithStepUp("PUT", `scholarships/programs/${id}`, { examSchedule: next });
    setBusy(null);
    if (res.ok) {
      setMsg({
        ok: true,
        text: examAt
          ? `${subject} opens ${new Date(examAt).toLocaleString()}. Announce again to move a paper already published.`
          : `${subject} follows the programme's own exam time again.`,
      });
      void loadPrograms();
    } else setMsg({ ok: false, text: await readApiError(res) });
  };

  const announceExam = async (id: string) => {
    setBusy(`announce-${id}`); setMsg(null);
    const res = await sendSms<{ notified: number; cbtExams: number; arena: boolean }>(
      "POST",
      `scholarships/programs/${id}/announce-exam`,
    );
    setBusy(null);
    if (res.ok) {
      const d = res.data;
      const surface = d?.cbtExams ? ` · ${d.cbtExams} CBT exam(s) published` : d?.arena ? " · games arena opened" : "";
      // EVERY qualified candidate can sit, whatever their school's plan — the
      // scholarship surface serves the paper and is always-on. This used to
      // name the schools left out for want of the PREMIUM CBT module; there are
      // none now, and saying so would be a warning about nothing.
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
    // TWO AWARDS, NOT ONE. The pupil gets fees; their SCHOOL gets free
    // ENTERPRISE for a session, two terms or one term. An operator committing
    // the platform to months of a paid tier should be told before they click,
    // not discover it afterwards on the tenant row.
    const schoolMonths = SCHOLARSHIP_SCHOOL_PRIZE_MONTHS[pos as 1 | 2 | 3];
    if (
      !confirm(
        `Award ${posLabel} position (${money(amount, a.awardCurrency)}) to ${a.studentName} (${a.schoolName})?\n\n` +
          `The pupil's award is credited against an open invoice, or held on their account until one is raised.\n\n` +
          `${a.schoolName} also receives ${schoolMonths} months of ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} at no charge. ` +
          `Their own plan and bill are unchanged.`,
      )
    )
      return;
    setBusy(`award-${a.id}`); setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/applications/${a.id}/award`, { position: pos });
    setBusy(null);
    if (res.ok) {
      setMsg({
        ok: true,
        text:
          `Awarded ${posLabel} position to ${a.studentName} — the row below says whether it landed on an invoice or is held as credit. ` +
          `${a.schoolName} now has ${schoolMonths} months of ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN}.`,
      });
      void loadApps();
    }
    else setMsg({ ok: false, text: await readApiError(res) });
  };

  /**
   * Take an award back.
   *
   * There was no way out of AWARDED at all: an award to the wrong candidate was
   * permanent and consumed one of only three positions for the programme. The
   * reason is required because it is what the office repeats to a family who
   * were already told they had won.
   */
  const revoke = async (a: Application) => {
    const reason = window.prompt(
      `Take back ${a.studentName}'s award? Their fee credit is reversed and the position is freed.\n\nWhy? (the family is told)`,
    );
    if (!reason?.trim()) return;
    setBusy(`revoke-${a.id}`); setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/applications/${a.id}/revoke`, { reason });
    setBusy(null);
    if (res.ok) { setMsg({ ok: true, text: `Award taken back — credit reversed and the position is free again.` }); void loadApps(); }
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
            <div className="space-y-1"><Label className="text-xs">🥇 1st prize ({f.currency})</Label><Input type="number" min={0} className="w-28" value={f.award} onChange={(e) => setF({ ...f, award: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs">🥈 2nd prize ({f.currency})</Label><Input type="number" min={0} className="w-28" value={f.award2} onChange={(e) => setF({ ...f, award2: e.target.value })} placeholder="= 1st" /></div>
            <div className="space-y-1"><Label className="text-xs">🥉 3rd prize ({f.currency})</Label><Input type="number" min={0} className="w-28" value={f.award3} onChange={(e) => setF({ ...f, award3: e.target.value })} placeholder="= 1st" /></div>
            <div className="space-y-1"><Label className="text-xs">Budget ({f.currency})</Label><Input type="number" min={0} className="w-32" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></div>
            <div className="space-y-1">
              <Label className="text-xs">Basis</Label>
              <select aria-label="Basis" value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} className={sel}>
                <option value="BOTH">Merit + need</option><option value="MERIT">Merit</option><option value="NEED">Need</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              {/* THE CURRENCY THE AWARD IS PAID IN. It has to match the school's
                  own fee currency for the credit to post — there is no FX rate
                  here, and converting one to clear a family's fees would be
                  worse than refusing. Measured before this existed: three of
                  six awards in a run were refused because one school bills in
                  GHS while every award was denominated in naira. */}
              <select
                aria-label="Award currency"
                value={f.currency}
                onChange={(e) => setF({ ...f, currency: e.target.value })}
                className={sel}
              >
                {Object.values(CURRENCIES).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className={sel}>
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

        {/* THE REUSABLE QUESTION LIBRARY.
            A programme's paper holds COPIES, never references — a paper that
            has been sat must not change under the candidates who sat it — so
            editing here changes what FUTURE papers are built from and touches
            no paper already built. That is the whole semantics, and the copy
            button says so. */}
        <div className="space-y-2 rounded-md border border-border p-3">
          {/* THE SAME WEIGHT AS "New program". This was styled as a muted
              caption — the class used for the "Programs" and "Applications"
              list LABELS — and wedged between two cards, so a whole feature
              read as a heading nobody was meant to click. A feature that
              cannot be found is not delivered. */}
          <p className="text-sm font-medium">Question library</p>
          <p className="text-xs text-muted-foreground">
            Write a question once and reuse it across programmes. A paper takes a COPY, so correcting one here
            changes what future papers are built from and never alters a paper already sat.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (lib) { setLib(null); return; }
                void loadLibrary();
              }}
            >
              {lib ? "Hide" : "Open"} library
            </Button>
            {lib && (
              <>
                <select
                  aria-label="Filter the library by subject"
                  className={sel}
                  value={libFilter.subject}
                  onChange={(e) => setLibFilter((f) => ({ ...f, subject: e.target.value, page: 1 }))}
                >
                  <option value="">All subjects</option>
                  {/* Only subjects the library ACTUALLY holds, so a picker can
                      never offer an empty one. */}
                  {lib.subjects.map((sub) => (
                    <option key={sub} value={sub}>{sub}</option>
                  ))}
                </select>
                <Input
                  className="h-8 w-44"
                  aria-label="Search the library"
                  placeholder="Search questions"
                  value={libFilter.q}
                  onChange={(e) => setLibFilter((f) => ({ ...f, q: e.target.value, page: 1 }))}
                />
                <span className="text-xs text-muted-foreground">
                  {lib.total.toLocaleString()}
                  {lib.total >= lib.countCap ? "+" : ""} question(s)
                </span>
              </>
            )}
          </div>

          {libFailed && (
            <p className="text-xs text-destructive">
              The library could not be loaded. Do not treat it as empty — you may retype questions you
              already have.
            </p>
          )}

          {lib && (
            <>
              {/* AUTHORING MOVED, and this says where. A question now belongs to
                  a BANK, and a bank is written on its own page — leaving the old
                  compose form here would offer a control the server refuses,
                  which is the defect this repo keeps recording. */}
              <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
                Questions are written on the{" "}
                <a className="underline" href="/operator/question-banks">Question banks</a>{" "}
                page, a bank at a time. This panel draws SAVED questions onto a paper.
              </p>

              {/* Copy the selection onto a paper. */}
              {libPicked.size > 0 && programs.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/40 p-2 text-xs">
                  <span className="font-medium">{libPicked.size} selected</span>
                  <span className="text-muted-foreground">add to:</span>
                  {programs.map((pr) => (
                    <Button key={pr.id} size="sm" variant="ghost" disabled={busy === "lib"} onClick={() => copyLibraryTo(pr.id)}>
                      {pr.title}
                    </Button>
                  ))}
                  {/* The semantics, stated where the click happens. */}
                  <span className="text-muted-foreground">
                    — copied onto the paper, so later edits here will not change it.
                  </span>
                </div>
              )}

              {lib.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {libFilter.subject || libFilter.q ? "No questions match." : "The library is empty — add one above."}
                </p>
              ) : (
                <ol className="space-y-1">
                  {lib.items.map((q) => (
                    <li key={q.id} className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        aria-label={`Select "${q.text.slice(0, 40)}"`}
                        checked={libPicked.has(q.id)}
                        onChange={(e) =>
                          setLibPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(q.id); else next.delete(q.id);
                            return next;
                          })
                        }
                      />
                      <span className="flex-1">
                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[0.65rem] uppercase tracking-wide">{q.subject}</span>
                        {q.text}
                        <span className="ml-1.5 text-muted-foreground">answer: {q.options[q.answerIndex] ?? "(none)"}</span>
                        {q.note && <span className="ml-1.5 italic text-muted-foreground">({q.note})</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {(lib.hasMore || libFilter.page > 1) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Button size="sm" variant="ghost" disabled={libFilter.page <= 1}
                    onClick={() => setLibFilter((f) => ({ ...f, page: f.page - 1 }))}>Previous</Button>
                  <span>Page {libFilter.page}</span>
                  <Button size="sm" variant="ghost" disabled={!lib.hasMore}
                    onClick={() => setLibFilter((f) => ({ ...f, page: f.page + 1 }))}>Next</Button>
                </div>
              )}
            </>
          )}
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
                onLoadPaper={() => loadPaper(pr.id)}
                onPublish={(publish) => publishResults(pr.id, publish)}
                onSaveWindow={(current, subject, at, mins) => saveWindow(pr.id, current, subject, at, mins)}
                onRemoveQuestion={(index) => removeQuestion(pr.id, index)}
                onEditQuestion={(index, next) => editQuestion(pr.id, index, next)}
                candidates={apps.filter((a) => a.programId === pr.id && a.status === "QUALIFIED")}
                onRecordScores={(marks) => recordScores(pr.id, marks)}
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
            <select aria-label="Status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setAppPage(1); }} className={sel}>
              <option value="">All (submitted)</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="SHORTLISTED">Shortlisted</option>
              <option value="QUALIFIED">Qualified (exam candidates)</option>
              <option value="AWARDED">Awarded</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          {/* THE BACKLOG, PLATFORM-WIDE, and never narrowed by the filter or the
              page: a count a filter can change is a count a filter can hide,
              and this one answers "is anyone waiting on us". */}
          {appPageInfo.undecidedTotal > 0 && (
            <p className="text-xs text-muted-foreground">
              <strong>
                {appPageInfo.undecidedTotal.toLocaleString()}
                {appPageInfo.undecidedTotal >= appPageInfo.countCap ? "+" : ""}
              </strong>{" "}
              awaiting a decision{statusFilter ? " (platform-wide, not just this filter)" : ""} — oldest first.
            </p>
          )}
          {picked.size > 0 && (
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-border/70 bg-muted/40 p-2 text-xs">
              <span className="mr-1 font-medium">{picked.size} selected</span>
              {(["REVIEW", "SHORTLIST", "QUALIFY", "REJECT"] as const).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant={a === "REJECT" ? "outline" : "ghost"}
                  disabled={busy === "bulk"}
                  onClick={() => decideSelected(a)}
                >
                  {a === "REVIEW" ? "Mark reviewing" : a === "SHORTLIST" ? "Shortlist" : a === "QUALIFY" ? "Qualify for exam" : "Reject"}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
              {/* Awarding is deliberately absent: it moves money, grants the
                  school a free tier and takes one of three positions, so it
                  stays one pupil at a time behind re-authentication. */}
              <span className="text-muted-foreground">Awarding stays per pupil.</span>
            </div>
          )}
          {apps.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label="Select every application on this page"
                checked={picked.size === apps.length}
                onChange={(e) => setPicked(e.target.checked ? new Set(apps.map((a) => a.id)) : new Set())}
              />
              Select this page ({apps.length})
            </label>
          )}
          {appsFailed ? (
            <p className="text-sm text-destructive">
              Applications could not be loaded. Reload before treating the queue as clear — families are
              waiting on a decision.
            </p>
          ) : (
            apps.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {statusFilter ? "No applications match this filter." : "No applications yet."}
              </p>
            )
          )}
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
                        <input
                          type="checkbox"
                          className="mr-2 align-middle"
                          aria-label={`Select ${a.studentName}`}
                          checked={picked.has(a.id)}
                          onChange={(e) =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(a.id);
                              else next.delete(a.id);
                              return next;
                            })
                          }
                        />
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
                        {/* Upheld and open are DIFFERENT facts about a child, and the old single
    figure also counted complaints the school dismissed. `disciplineComplaints`
    is the legacy snapshot shape — shown as it was recorded, because a signals
    block is what a reviewer was told at the time. */}
{s.disciplineUpheld != null || s.disciplineOpen != null ? (
  <>
    {" "}· discipline: <strong>{s.disciplineUpheld ?? 0}</strong> upheld
    {(s.disciplineOpen ?? 0) > 0 && <>, {s.disciplineOpen} undecided</>}
  </>
) : (
  s.disciplineComplaints != null && <> · discipline (legacy count): <strong>{s.disciplineComplaints}</strong></>
)}
                        {s.tasksCompleted != null && <> · tasks done: <strong>{s.tasksCompleted}</strong></>}
                        {" "}<span className="italic">(for judgement only, not a verdict)</span>
                      </p>
                    )}
                    {a.status === "AWARDED" && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {/* The only way out of AWARDED. Without it a mistaken
                            award is permanent and holds one of three positions
                            for the whole programme. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          disabled={busy === `revoke-${a.id}`}
                          onClick={() => revoke(a)}
                        >
                          Take award back
                        </Button>
                        <span className="text-xs text-muted-foreground">reverses the fee credit and frees the position</span>
                      </div>
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
                      /*
                        GRANTED IS NOT CREDITED, and this line used to assert the
                        second unconditionally: "fees credit posted." on every
                        awarded row, whether or not anything had posted.

                        An award is disbursed as a fees credit against the pupil's
                        OPEN invoice. With no open invoice — the ordinary case when
                        an award is decided before the term's fees are raised —
                        nothing posts and nothing retries. Measured on the demo
                        tenant: four AWARDED applications totalling NGN 800,000
                        with no payment, every one of them reading "fees credit
                        posted".

                        The award standing is correct (a decision is not thrown
                        away over a posting problem) and the family is told the
                        truth; it was the FUNDER's own screen that was wrong.

                        SINCE THEN the no-invoice case stopped being a dead end:
                        the award goes onto the pupil's CREDIT LEDGER, the same
                        mechanism a dedicated-account transfer already uses when
                        there is no invoice to settle. So there are now three
                        outcomes, and "credited" alone would hide the difference
                        between money that moved a bill today and money waiting
                        for the next one.
                      */
                      <p className={`mt-1 text-xs ${a.disbursed === false ? "text-amber-600 dark:text-amber-400" : "text-primary"}`}>
                        {a.awardPosition ? `${a.awardPosition === 1 ? "🥇 1st" : a.awardPosition === 2 ? "🥈 2nd" : "🥉 3rd"} place — ` : ""}
                        Awarded {money(a.awardMinor, a.awardCurrency)} ·{" "}
                        {a.disbursed === false ? "NOT credited — " : ""}
                        {/* THE REASON, not a guess at it. `disburseFeesCredit`
                            refuses for three different reasons needing three
                            different actions, and this line stated ONE of them
                            as though it were always the reason — so an award
                            that simply had no bill to credit sent an operator
                            to check a currency setting that was correct. The
                            audit row has recorded which since that arm was
                            written; the screen somebody works from had not. */}
                        {a.disbursed === false
                          ? a.disbursementIssue ??
                            "NOT yet credited. This award was decided before the reason was recorded — check the audit log for it."
                          : a.disbursementKind === "CREDIT"
                            ? "held as credit on the pupil's account — it comes off their next bill."
                            : "fees credit posted against an open invoice."}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
          {(appPageInfo.hasMore || appPage > 1) && (
            <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Button size="sm" variant="ghost" disabled={appPage <= 1} onClick={() => setAppPage((n) => n - 1)}>
                Previous
              </Button>
              <span>
                Showing {(appPage - 1) * appPageInfo.pageSize + 1}&ndash;
                {(appPage - 1) * appPageInfo.pageSize + apps.length} of{" "}
                {appPageInfo.total.toLocaleString()}
                {appPageInfo.total >= appPageInfo.countCap ? "+" : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!appPageInfo.hasMore}
                onClick={() => setAppPage((n) => n + 1)}
              >
                Next
              </Button>
            </div>
          )}
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
  onLoadPaper,
  onRemoveQuestion,
  onEditQuestion,
  candidates,
  onRecordScores,
  onPublish,
  onSaveWindow,
  onAnnounce,
  onCollect,
  onStatus,
}: {
  pr: Program;
  busy: string | null;
  onSaveExam: (v: { mode: string; at: string; venue: string; duration: string; cap: string }) => void;
  onAddQuestion: (q: { text: string; options: string[]; answerIndex: number; subject?: string | null }) => void;
  /** Read the paper back — admin-only, and its own route. */
  onLoadPaper: () => Promise<Question[] | null>;
  onRemoveQuestion: (index: number) => Promise<boolean>;
  onEditQuestion: (
    index: number,
    next: { text: string; options: string[]; answerIndex: number; subject: string | null },
  ) => Promise<boolean>;
  candidates: Array<Serialized<ScholarshipApplicationDto>>;
  onRecordScores: (marks: Array<{ applicationId: string; scorePct: number }>) => Promise<boolean>;
  onPublish: (publish: boolean) => void;
  onSaveWindow: (
    current: Record<string, { examAt: string; durationMin?: number }>,
    subject: string,
    examAt: string,
    durationMin: number | null,
  ) => void;
  onAnnounce: () => void;
  onCollect: () => void;
  onStatus: (status: string) => void;
}) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { shortDate } = useFormat();
  const [mode, setMode] = React.useState(pr.examMode ?? "");
  const [at, setAt] = React.useState("");
  const [venue, setVenue] = React.useState(pr.examVenue ?? "");
  const [cap, setCap] = React.useState(pr.maxCandidatesPerSchool != null ? String(pr.maxCandidatesPerSchool) : "");
  const [spread, setSpread] = React.useState<Array<Serialized<ScholarshipSchoolSpreadDto>> | null>(null);
  const [spreadFailed, setSpreadFailed] = React.useState(false);
  const [duration, setDuration] = React.useState(String(pr.examDurationMin));
  const [showQ, setShowQ] = React.useState(false);
  // THE PAPER AS WRITTEN. Questions could only ever be APPENDED — no read, no
  // remove — so a typo, or a wrong correct-option, was permanent, on the paper
  // that decides who is awarded money. Read back only for `scholarship.admin`,
  // from its own route; the candidate portal gets the COUNT and nothing else.
  const [paper, setPaper] = React.useState<Question[] | null>(null);
  const [paperFailed, setPaperFailed] = React.useState(false);

  const loadPaper = async () => {
    setPaper(null);
    setPaperFailed(false);
    const rows = await onLoadPaper();
    if (rows === null) setPaperFailed(true);
    else setPaper(rows);
  };
  const removeQuestion = async (index: number) => {
    if (!confirm("Remove this question from the paper?")) return;
    if (await onRemoveQuestion(index)) await loadPaper();
  };
  // A TO E. The API has always accepted up to six options and this form offered
  // FOUR, so an owner writing a five-option question simply could not — the
  // familiar shape of a control the server would have taken.
  const [q, setQ] = React.useState({ text: "", a: "", b: "", c: "", d: "", e: "", answer: 0 });
  // WHICH PAPER this question goes on. A scholarship may be examined in several
  // subjects, and the subjects ARE whichever ones the questions carry — there
  // is no separate list of papers to fall out of step with. Blank means the
  // programme's own category, which is the single-paper behaviour unchanged.
  //
  // It DELIBERATELY persists between questions: a paper is authored a question
  // at a time, and re-typing the subject for each one is how half of them end
  // up on the wrong paper.
  const [subject, setSubject] = React.useState("");
  const [windows, setWindows] = React.useState<Record<string, { at?: string; mins?: string }>>({});
  /** Which question is being corrected, if any. */
  const [editing, setEditing] = React.useState<number | null>(null);
  const [showMarks, setShowMarks] = React.useState(false);
  const [marks, setMarks] = React.useState<Record<string, string>>({});

  const addQ = () => {
    const options = [q.a, q.b, q.c, q.d, q.e].map((o) => o.trim()).filter(Boolean);
    if (!q.text.trim() || options.length < 2) return;
    const next = {
      text: q.text.trim(),
      options,
      answerIndex: Math.min(q.answer, options.length - 1),
      subject: subject.trim() || null,
    };
    if (editing !== null) {
      void onEditQuestion(editing, next).then((okDone) => {
        if (!okDone) return;
        setEditing(null);
        setQ({ text: "", a: "", b: "", c: "", d: "", e: "", answer: 0 });
        void loadPaper();
      });
      return;
    }
    onAddQuestion(next);
    setQ({ text: "", a: "", b: "", c: "", d: "", e: "", answer: 0 });
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium">{pr.title}</span>{" "}
          <span className="text-muted-foreground">
            🥇{money(pr.awardMinor, pr.awardCurrency)} 🥈{money(pr.award2Minor ?? pr.awardMinor, pr.awardCurrency)} 🥉{money(pr.award3Minor ?? pr.awardMinor, pr.awardCurrency)}
          </span>{" "}
          <Badge variant="outline">{String(pr.category).replaceAll("_", " ").toLowerCase()}</Badge>{" "}
          <Badge variant={pr.status === "OPEN" ? "secondary" : "outline"}>{pr.status}</Badge>{" "}
          {/* Budget vs what is already committed. The budget used to be collected,
              stored and never compared to anything; an award past it is refused
              now, and this is what makes that refusal predictable instead of a
              surprise at the moment of awarding. A budget of 0 means none was
              set, so nothing is shown. */}
          {pr.budgetMinor > 0 && (
            <Badge variant={pr.committedMinor >= pr.budgetMinor ? "destructive" : "outline"} className="font-normal">
              {money(pr.committedMinor, pr.awardCurrency)} of {money(pr.budgetMinor, pr.awardCurrency)} committed
            </Badge>
          )}
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
          <select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} className={sel}>
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
        <div className="flex items-center gap-1">
          {/* Without this the biggest school simply wins: on a 5,000-applicant
              run the school holding half the pupils took all six podium places
              and the smallest got no exam at all. */}
          <Label className="text-xs">Max per school</Label>
          <Input
            className="w-24"
            type="number"
            min={1}
            aria-label="Maximum candidates one school may qualify"
            placeholder="no limit"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
        <Button size="sm" variant="outline" disabled={busy === `exam-${pr.id}`} onClick={() => onSaveExam({ mode, at, venue, duration, cap })}>
          Save exam
        </Button>
        {/* AUTHORING IS THE SAME WORK whichever way the paper is sat. This was
            gated on ONLINE_CBT, so an owner running a PHYSICAL exam could not
            write its questions at all — while the API accepted them the whole
            time and nothing printed them. The two modes differ in how the paper
            reaches a candidate, not in how it is written. */}
        {(pr.examMode === "ONLINE_CBT" || pr.examMode === "PHYSICAL") && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = !showQ;
              setShowQ(next);
              if (next) void loadPaper();
            }}
          >
            {showQ ? "Hide" : "Review"} questions ({pr.examQuestionCount})
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
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (spread) { setSpread(null); return; }
            const res = await fetch(`/api/sms/scholarships/programs/${pr.id}/school-spread`);
            if (!res.ok) { setSpreadFailed(true); return; }
            setSpreadFailed(false);
            setSpread((await res.json()) as Array<Serialized<ScholarshipSchoolSpreadDto>>);
          }}
        >
          {spread ? "Hide spread" : "Spread by school"}
        </Button>
        {/* THE PHYSICAL EQUIVALENT OF "Collect results". A paper exam has no
            sitting to harvest, so the marks are typed in — and without this the
            mode dead-ended at the announcement. */}
        {pr.examMode === "PHYSICAL" && (
          <Button size="sm" variant="outline" onClick={() => setShowMarks((v) => !v)}>
            {showMarks ? "Hide mark sheet" : `Enter marks (${candidates.length})`}
          </Button>
        )}
        {/* PUBLISHING IS A DECISION, AND IT COMES AFTER REVIEW. A score is a
            fact about a child's exam; it reaches every school on the platform
            only once the owner has looked at the marking. The button says what
            the table will contain, because "publish results" alone does not
            tell an operator whether they are about to name a pupil. */}
        {(pr.examMode === "ONLINE_CBT" || pr.examMode === "GAMES" || pr.examMode === "PHYSICAL") && (
          <Button
            size="sm"
            variant={pr.resultsPublishedAt ? "ghost" : "outline"}
            disabled={busy === `pub-${pr.id}`}
            title={
              pr.resultsPublishedAt
                ? "Withdraw the table from every school"
                : "Every school on the platform will see the school, position and score — never a pupil's name"
            }
            onClick={() => onPublish(!pr.resultsPublishedAt)}
          >
            {pr.resultsPublishedAt ? "Withdraw results" : "Publish results"}
          </Button>
        )}
        {pr.resultsPublishedAt && (
          <span className="text-xs text-muted-foreground">
            published {shortDate(pr.resultsPublishedAt)} · visible to every school
          </span>
        )}
      </div>

      {/* A CAP STOPS ONE SCHOOL CROWDING THE FIELD; it does not say that a
          school has NOBODY in it, which is the other half of the question and
          the one nobody would notice. */}
      {spreadFailed && (
        <p className="text-xs text-destructive">
          The spread could not be loaded — do not read that as every school being represented.
        </p>
      )}
      {spread && (
        <div className="space-y-1 rounded-md border border-dashed border-border p-2 text-xs">
          {spread.length === 0 ? (
            <p className="text-muted-foreground">No applications yet, so no school is represented.</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {spread.length} school(s) represented
                {pr.maxCandidatesPerSchool != null ? ` · limit ${pr.maxCandidatesPerSchool} qualified per school` : " · no per-school limit set"}
              </p>
              {spread.map((r) => (
                <div key={r.schoolId} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[14rem] font-medium">{r.schoolName ?? "(unnamed school)"}</span>
                  <span>{r.applied} applied</span>
                  <span>· {r.qualified} qualified</span>
                  <span>· {r.awarded} awarded</span>
                  {/* Null is NO CAP, which is not the same statement as "full". */}
                  {r.seatsLeft !== null && (
                    <span className={r.seatsLeft === 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                      · {r.seatsLeft === 0 ? "at the limit" : `${r.seatsLeft} seat(s) left`}
                    </span>
                  )}
                  {r.qualified + r.awarded === 0 && (
                    <span className="text-amber-600 dark:text-amber-400">· nobody qualified yet</span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* PHYSICAL mark sheet */}
      {showMarks && pr.examMode === "PHYSICAL" && (
        <div className="space-y-2 rounded-md border border-dashed border-border p-2">
          <p className="text-xs text-muted-foreground">
            Enter each candidate&apos;s mark as a percentage. Leave a box blank for anyone whose script is not
            marked yet — only what you fill in is recorded, and you can come back.
          </p>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No qualified candidates yet. Qualify candidates from the Applications list first.
            </p>
          ) : (
            <>
              {candidates.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-[16rem]">
                    {c.studentName} <span className="text-muted-foreground">· {c.schoolName}</span>
                  </span>
                  <Input
                    aria-label={`Mark for ${c.studentName} (percent)`}
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    className="h-8 w-24"
                    placeholder={c.examScorePct != null ? String(c.examScorePct) : "%"}
                    value={marks[c.id] ?? ""}
                    onChange={(e) => setMarks((m) => ({ ...m, [c.id]: e.target.value }))}
                  />
                  {/* What is ALREADY recorded, so re-opening the sheet does not
                      read as though nothing was entered. */}
                  {c.examScorePct != null && (
                    <span className="text-xs text-muted-foreground">recorded: {c.examScorePct}%</span>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                disabled={busy === `scores-${pr.id}`}
                onClick={() => {
                  const entered = candidates
                    .map((c) => ({ applicationId: c.id, raw: (marks[c.id] ?? "").trim() }))
                    .filter((m) => m.raw !== "")
                    .map((m) => ({ applicationId: m.applicationId, scorePct: Number(m.raw) }));
                  if (entered.length === 0) return;
                  void onRecordScores(entered).then((ok) => {
                    // Only clear what was accepted — a rejected sheet must keep
                    // what the operator typed, or they retype every mark.
                    if (ok) setMarks({});
                  });
                }}
              >
                Record marks
              </Button>
            </>
          )}
        </div>
      )}

      {/* The question paper — authored the same way for both modes. */}
      {showQ && (pr.examMode === "ONLINE_CBT" || pr.examMode === "PHYSICAL") && (
        <div className="space-y-2 rounded-md border border-dashed border-border p-2">
          {/* PRINT. The papers are DERIVED from the questions' subjects, so there
              is one link per subject — printing "the programme" would staple
              two different exams together. Both are owner-only routes; a
              candidate's own school can print neither.
              The KEY is a separate link, not a checkbox, because printing it is
              exam-integrity material and has to be distinguishable in the audit
              trail from printing the paper. */}
          {paper !== null && paper.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-2 text-xs">
              <span className="text-muted-foreground">Print:</span>
              {[...new Set(paper.map((q) => q.subject ?? ""))].map((subj) => (
                <span key={subj || "default"} className="flex items-center gap-1">
                  <a
                    className="underline"
                    href={`/api/sms/scholarships/programs/${pr.id}/paper.pdf${subj ? `?subject=${encodeURIComponent(subj)}` : ""}`}
                  >
                    {subj || "paper"}
                  </a>
                  <a
                    className="text-destructive underline"
                    title="The answer key — not for candidates"
                    href={`/api/sms/scholarships/programs/${pr.id}/answer-key.pdf${subj ? `?subject=${encodeURIComponent(subj)}` : ""}`}
                  >
                    key
                  </a>
                </span>
              ))}
              {pr.examMode === "PHYSICAL" && (
                <span className="text-muted-foreground">
                  — a physical exam is sat from these sheets; nothing is published to candidates.
                </span>
              )}
            </div>
          )}
          {paperFailed ? (
            // A failed read must not read as "this paper is empty" — that would
            // invite the operator to type the whole thing again.
            <p className="text-xs text-destructive">
              The questions could not be loaded. Nothing has been removed — try opening this again
              before adding any, or you may duplicate what is already there.
            </p>
          ) : paper === null ? (
            <p className="text-xs text-muted-foreground">Loading the paper…</p>
          ) : paper.length === 0 ? (
            <p className="text-xs text-muted-foreground">No questions yet.</p>
          ) : (
            <ol className="space-y-1.5">
              {paper.map((question) => (
                <li key={question.index} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 tabular-nums text-muted-foreground">{question.index + 1}.</span>
                  <span className="flex-1">
                    {question.subject && (
                      <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[0.65rem] uppercase tracking-wide">
                        {question.subject}
                      </span>
                    )}
                    {question.text}
                    <span className="ml-1.5 text-muted-foreground">
                      {/* The KEY, marked. Reading it back is the whole point:
                          a wrong correct-option marks every right answer wrong,
                          and there was no way to see it, let alone fix it. */}
                      answer: {question.options[question.answerIndex] ?? "(none)"}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit question ${question.index + 1}`}
                    disabled={busy === `q-${pr.id}`}
                    onClick={() => {
                      // Load it into the composer so a correction is made in
                      // the same form that wrote it, rather than a second one.
                      const [a = "", b = "", c = "", d = "", e = ""] = question.options;
                      setQ({ text: question.text, a, b, c, d, e, answer: question.answerIndex });
                      setSubject(question.subject ?? "");
                      setEditing(question.index);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove question ${question.index + 1}`}
                    disabled={busy === `q-${pr.id}`}
                    onClick={() => void removeQuestion(question.index)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ol>
          )}
          {/* WHEN EACH PAPER OPENS. The subjects are whichever ones the
              questions carry, so this list cannot name a paper that does not
              exist — and a subject with no row here simply uses the
              programme's own exam time, which is the single-paper behaviour. */}
          {paper && paper.length > 0 && subjectsOf(paper).length > 1 && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <p className="text-xs font-medium">When each paper opens</p>
              {subjectsOf(paper).map((subj) => {
                const current = (pr.examSchedule ?? {}) as Record<string, { examAt: string; durationMin?: number }>;
                const own = current[subj];
                return (
                  <div key={subj} className="flex flex-wrap items-end gap-2">
                    <span className="w-32 text-xs">{subj}</span>
                    <Input
                      aria-label={`${subj} paper opens`}
                      type="datetime-local"
                      className="w-52"
                      defaultValue={own?.examAt ? own.examAt.slice(0, 16) : ""}
                      onChange={(e) => setWindows((w) => ({ ...w, [subj]: { ...w[subj], at: e.target.value } }))}
                    />
                    <Input
                      aria-label={`${subj} paper minutes`}
                      type="number"
                      min={1}
                      className="w-24"
                      placeholder="mins"
                      defaultValue={own?.durationMin ?? ""}
                      onChange={(e) => setWindows((w) => ({ ...w, [subj]: { ...w[subj], mins: e.target.value } }))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `sched-${pr.id}`}
                      onClick={() =>
                        onSaveWindow(
                          current,
                          subj,
                          windows[subj]?.at ?? (own?.examAt ? own.examAt.slice(0, 16) : ""),
                          Number(windows[subj]?.mins ?? own?.durationMin ?? 0) || null,
                        )
                      }
                    >
                      Save
                    </Button>
                    {!own && <span className="text-xs text-muted-foreground">uses the programme&apos;s time</span>}
                  </div>
                );
              })}
            </div>
          )}
          <Input placeholder="Question text" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            {(["a", "b", "c", "d", "e"] as const).map((k, i) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name={`ans-${pr.id}`} checked={q.answer === i} onChange={() => setQ({ ...q, answer: i })} />
                <Input placeholder={`${String.fromCharCode(65 + i)}${i < 2 ? " *" : ""}`} value={q[k]} onChange={(e) => setQ({ ...q, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`subj-${pr.id}`} className="text-xs">
                Subject <span className="font-normal text-muted-foreground">(blank = one paper)</span>
              </Label>
              <Input
                id={`subj-${pr.id}`}
                className="w-44"
                placeholder="e.g. Mathematics"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <Button size="sm" disabled={busy === `q-${pr.id}`} onClick={addQ}>
              {editing !== null ? `Save question ${editing + 1}` : "Add question"}
            </Button>
            {editing !== null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setQ({ text: "", a: "", b: "", c: "", d: "", e: "", answer: 0 });
                }}
              >
                Cancel
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              Select the radio next to the correct option. Answers stay server-side. Questions sharing a
              subject become one paper.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
