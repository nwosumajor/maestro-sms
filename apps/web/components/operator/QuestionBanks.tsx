"use client";

// =============================================================================
// QuestionBanks — the platform owner writes a subject's paper, one question at
// a time, then saves the bank.
//
// THE SHAPE MIRRORS THE CBT MODULE deliberately: pick a subject, then a single
// composer that takes the question, options A to E, and which one is correct.
// An owner who has authored a school exam already knows this screen.
//
// A BANK BEING WRITTEN IS DRAFT AND CANNOT BE DRAWN ON. That is what makes
// "Save bank" a control rather than a label, and it is why the status is on the
// row, on the header, and in the refusal a paper gets if it tries.
// =============================================================================

import * as React from "react";
import type {
  ScholarshipBankDetailDto,
  ScholarshipBankPageDto,
  ScholarshipSubjectOption,
  Serialized,
} from "@sms/types";
import { SCHOLARSHIP_BANK_TARGET_MIN, SCHOLARSHIP_BANK_TARGET_MAX } from "@sms/types";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const EMPTY = { text: "", a: "", b: "", c: "", d: "", e: "", answer: 0, note: "" };

export function QuestionBanks() {
  const [subjects, setSubjects] = React.useState<ScholarshipSubjectOption[] | null>(null);
  const [banks, setBanks] = React.useState<Serialized<ScholarshipBankPageDto> | null>(null);
  const [open, setOpen] = React.useState<Serialized<ScholarshipBankDetailDto> | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [filter, setFilter] = React.useState({ subjectCode: "", status: "", page: 1 });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [newBank, setNewBank] = React.useState({ subjectCode: "", name: "" });
  const [draft, setDraft] = React.useState(EMPTY);
  // Correcting an open bank. A typo in the name, or a bank filed under the
  // wrong subject, used to be permanent — the only way out was to delete it,
  // which cascades its questions.
  const [rename, setRename] = React.useState<{ name: string; subjectCode: string } | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  const loadBanks = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter.subjectCode) qs.set("subjectCode", filter.subjectCode);
    if (filter.status) qs.set("status", filter.status);
    if (filter.page > 1) qs.set("page", String(filter.page));
    const res = await fetch(`/api/sms/scholarships/banks?${qs.toString()}`);
    if (!res.ok) {
      // A failed read must not read as "no banks" — that invites an owner to
      // write a paper they already have.
      setFailed(true);
      return;
    }
    setFailed(false);
    setBanks((await res.json()) as Serialized<ScholarshipBankPageDto>);
  }, [filter]);

  React.useEffect(() => {
    void (async () => {
      const r = await fetch("/api/sms/scholarships/subjects");
      if (r.ok) setSubjects((await r.json()) as ScholarshipSubjectOption[]);
    })();
  }, []);
  React.useEffect(() => { void loadBanks(); }, [loadBanks]);

  const openBank = async (id: string) => {
    const res = await fetch(`/api/sms/scholarships/banks/${id}`);
    if (!res.ok) { setMsg({ ok: false, text: "That bank could not be opened." }); return; }
    setOpen((await res.json()) as Serialized<ScholarshipBankDetailDto>);
    setDraft(EMPTY);
    setEditing(null);
    setRename(null);
  };

  const createBank = async () => {
    if (!newBank.subjectCode) { setMsg({ ok: false, text: "Choose a subject for the bank." }); return; }
    setBusy("new"); setMsg(null);
    const res = await sendWithStepUp("POST", "scholarships/banks", {
      subjectCode: newBank.subjectCode,
      name: newBank.name.trim() || null,
    });
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    const bank = (await res.json()) as Serialized<ScholarshipBankDetailDto>;
    setNewBank({ subjectCode: "", name: "" });
    setMsg({ ok: true, text: `${bank.name} created — write its questions below.` });
    await loadBanks();
    // Straight into the composer: creating a bank is the FIRST step of writing
    // one, and making the owner find and click it again is a step for nothing.
    await openBank(bank.id);
  };

  const saveQuestion = async () => {
    if (!open) return;
    const options = [draft.a, draft.b, draft.c, draft.d, draft.e].map((o) => o.trim()).filter(Boolean);
    if (!draft.text.trim() || options.length < 2) {
      setMsg({ ok: false, text: "A question needs its text and at least two options." });
      return;
    }
    setBusy("q"); setMsg(null);
    const body = {
      text: draft.text.trim(),
      options,
      answerIndex: Math.min(draft.answer, options.length - 1),
      note: draft.note.trim() || null,
    };
    const res = editing
      ? await sendWithStepUp("PUT", `scholarships/questions/${editing}`, body)
      : await sendWithStepUp("POST", "scholarships/questions", { bankId: open.id, ...body });
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    setMsg({ ok: true, text: editing ? "Question updated." : "Question added." });
    // The composer CLEARS and stays open: the next question is the expected next
    // act, and re-opening a form sixty times is the difference between a usable
    // screen and an unusable one.
    setDraft(EMPTY);
    setEditing(null);
    await openBank(open.id);
    await loadBanks();
  };

  const deleteQuestion = async (id: string) => {
    if (!open || !confirm("Remove this question from the bank?")) return;
    setBusy("q");
    const res = await sendWithStepUp("DELETE", `scholarships/questions/${id}`, undefined);
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    setMsg({ ok: true, text: "Question removed." });
    await openBank(open.id);
    await loadBanks();
  };

  const saveDetails = async () => {
    if (!open || !rename) return;
    setBusy("bank"); setMsg(null);
    const res = await sendWithStepUp("PUT", `scholarships/banks/${open.id}`, {
      name: rename.name.trim() || null,
      ...(rename.subjectCode && rename.subjectCode !== open.subjectCode
        ? { subjectCode: rename.subjectCode }
        : {}),
    });
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    const moved = rename.subjectCode && rename.subjectCode !== open.subjectCode;
    setMsg({
      ok: true,
      // SAYS WHAT IT DID NOT REACH. A paper holds COPIES, so moving a bank
      // leaves every paper already built from it exactly as it was — the same
      // sentence the delete gives, for the same reason.
      text: moved
        ? "Bank moved, and its questions with it. Papers already built from it are unchanged — they hold copies."
        : "Bank renamed.",
    });
    await openBank(open.id);
    await loadBanks();
  };

  const bankAction = async (path: string, ok: string) => {
    if (!open) return;
    setBusy("bank"); setMsg(null);
    const res = await sendWithStepUp("POST", `scholarships/banks/${open.id}/${path}`, {});
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    setMsg({ ok: true, text: ok });
    await openBank(open.id);
    await loadBanks();
  };

  const deleteBank = async (id: string, name: string, count: number) => {
    // Says what is NOT affected. Without it an owner reasonably fears that
    // deleting a bank alters a paper already built from it.
    if (!confirm(`Delete "${name}" and its ${count} question(s)?\n\nPapers already built from it are unaffected — they hold copies.`)) return;
    setBusy("bank");
    const res = await sendWithStepUp("DELETE", `scholarships/banks/${id}`, undefined);
    setBusy(null);
    if (!res.ok) { setMsg({ ok: false, text: await readApiError(res) }); return; }
    setMsg({ ok: true, text: `${name} deleted. No paper changed.` });
    if (open?.id === id) setOpen(null);
    await loadBanks();
  };

  return (
    <div className="space-y-4">
      {msg && (
        <p className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-muted text-foreground" : "border border-destructive/40 bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Create a question bank</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="bank-subject">Subject</Label>
            {/* THE CATALOGUE'S secondary subjects across EVERY curriculum, not
                one school's list: a scholarship is cross-school and the schools
                sitting it follow different curricula. */}
            <select
              id="bank-subject"
              className={sel}
              value={newBank.subjectCode}
              onChange={(e) => setNewBank((b) => ({ ...b, subjectCode: e.target.value }))}
            >
              <option value="">Choose a subject…</option>
              {(subjects ?? []).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.stages.map((x) => (x === "JUNIOR_SECONDARY" ? "junior" : "senior")).join(" / ")})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="bank-name">Name (optional)</Label>
            <Input id="bank-name" className="w-56" placeholder="defaults to the subject" value={newBank.name}
              onChange={(e) => setNewBank((b) => ({ ...b, name: e.target.value }))} />
          </div>
          <Button disabled={busy === "new" || !subjects} onClick={createBank}>Create question bank</Button>
          {subjects === null && <span className="text-xs text-muted-foreground">loading subjects…</span>}
        </CardContent>
      </Card>

      {open && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <span>{open.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-xs ${open.status === "READY" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"}`}>
                {open.status === "READY" ? "SAVED — papers may draw on it" : "DRAFT — not yet usable"}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {open.questionCount} question{open.questionCount === 1 ? "" : "s"}
                {/* GUIDANCE, NOT A RULE. A 40-question paper is not a mistake,
                    and refusing to save at 59 would invent a rule nobody set. */}
                {open.questionCount < SCHOLARSHIP_BANK_TARGET_MIN
                  ? ` · ${SCHOLARSHIP_BANK_TARGET_MIN}–${SCHOLARSHIP_BANK_TARGET_MAX} is the usual size`
                  : open.questionCount > SCHOLARSHIP_BANK_TARGET_MAX
                    ? ` · longer than the usual ${SCHOLARSHIP_BANK_TARGET_MAX}`
                    : ""}
              </span>
              <span className="ml-auto flex gap-1">
                {open.status === "DRAFT" ? (
                  <Button size="sm" disabled={busy === "bank" || open.questionCount === 0}
                    title={open.questionCount === 0 ? "Add a question first" : "Finish it — papers may then draw on it"}
                    onClick={() => bankAction("save", "Bank saved. Papers may now draw on it.")}>
                    Save bank
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy === "bank"}
                    onClick={() => bankAction("reopen", "Reopened — it can be corrected, and papers cannot draw on it until it is saved again.")}>
                    Reopen to edit
                  </Button>
                )}
                <Button size="sm" variant="ghost"
                  onClick={() => setRename(rename ? null : { name: open.name, subjectCode: open.subjectCode })}>
                  {rename ? "Cancel" : "Rename / move"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {rename && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="bank-rename">Name</Label>
                  <Input id="bank-rename" className="w-56" value={rename.name}
                    onChange={(e) => setRename({ ...rename, name: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="bank-resubject">Subject</Label>
                  <select id="bank-resubject" className={sel} value={rename.subjectCode}
                    onChange={(e) => setRename({ ...rename, subjectCode: e.target.value })}>
                    {(subjects ?? []).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                  </select>
                </div>
                <Button size="sm" disabled={busy === "bank"} onClick={saveDetails}>Save details</Button>
                {rename.subjectCode !== open.subjectCode && (
                  <p className="w-full text-xs text-muted-foreground">
                    Moving the subject moves this bank&rsquo;s {open.questionCount} question(s) with it, so they
                    stay on one paper. Papers already built from it are unchanged — they hold copies.
                  </p>
                )}
              </div>
            )}
            {open.status === "READY" && (
              <p className="text-xs text-muted-foreground">
                This bank is saved. Reopen it to add or change questions.
              </p>
            )}
            {open.status === "DRAFT" && (
              <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="q-text">
                    {editing ? "Correct the question" : `Question ${open.questionCount + 1}`}
                  </Label>
                  <Input id="q-text" placeholder="Type the question" value={draft.text}
                    onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  {(["a", "b", "c", "d", "e"] as const).map((k, i) => (
                    <div key={k} className="space-y-1">
                      <Label className="flex items-center gap-1 text-xs" htmlFor={`opt-${k}`}>
                        <input type="radio" aria-label={`${String.fromCharCode(65 + i)} is the correct answer`}
                          checked={draft.answer === i} onChange={() => setDraft((d) => ({ ...d, answer: i }))} />
                        {String.fromCharCode(65 + i)}{i < 2 ? " *" : ""}
                      </Label>
                      <Input id={`opt-${k}`} className="w-32" value={draft[k]}
                        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
                    </div>
                  ))}
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="q-note">Note (never printed)</Label>
                    <Input id="q-note" className="w-40" value={draft.note}
                      onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
                  </div>
                  <Button disabled={busy === "q"} onClick={saveQuestion}>
                    {editing ? "Save changes" : "Save question"}
                  </Button>
                  {editing && (
                    <Button variant="ghost" onClick={() => { setEditing(null); setDraft(EMPTY); }}>Cancel</Button>
                  )}
                </div>
                {/* The radio marks the answer; saying so removes the one thing a
                    reader could get wrong on this form. */}
                <p className="text-xs text-muted-foreground">
                  Tick the option that is correct. A and B are required; C, D and E are optional.
                </p>
              </div>
            )}

            {open.questions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No questions yet.</p>
            ) : (
              <ol className="space-y-1">
                {open.questions.map((q, i) => (
                  <li key={q.id} className="flex items-start gap-2 rounded-md border border-border/60 p-2 text-sm">
                    <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                    <span className="flex-1">
                      {q.text}
                      <span className="ml-2 text-muted-foreground">
                        answer: {q.options[q.answerIndex] ?? "(none)"}
                      </span>
                      {q.note && <span className="ml-2 italic text-muted-foreground">({q.note})</span>}
                    </span>
                    {open.status === "DRAFT" && (
                      <>
                        <Button size="sm" variant="ghost" aria-label={`Edit question ${i + 1}`}
                          onClick={() => {
                            const [a = "", b = "", c = "", d = "", e = ""] = q.options;
                            setDraft({ text: q.text, a, b, c, d, e, answer: q.answerIndex, note: q.note ?? "" });
                            setEditing(q.id);
                          }}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive"
                          aria-label={`Delete question ${i + 1}`} disabled={busy === "q"}
                          onClick={() => deleteQuestion(q.id)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Question banks</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Filter by subject" className={sel} value={filter.subjectCode}
              onChange={(e) => setFilter((f) => ({ ...f, subjectCode: e.target.value, page: 1 }))}>
              <option value="">All subjects</option>
              {/* Only subjects a bank EXISTS for, so the filter never offers an
                  empty one. */}
              {(banks?.subjects ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
            <select aria-label="Filter by status" className={sel} value={filter.status}
              onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value, page: 1 }))}>
              <option value="">Any status</option>
              <option value="DRAFT">Draft</option>
              <option value="READY">Saved</option>
            </select>
            {banks && <span className="text-xs text-muted-foreground">{banks.total} bank(s)</span>}
          </div>
          {failed ? (
            <p className="text-sm text-destructive">
              The banks could not be loaded. Do not treat this as none — you may write a paper you already have.
            </p>
          ) : !banks ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : banks.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter.subjectCode || filter.status ? "No banks match." : "No question banks yet — create one above."}
            </p>
          ) : (
            <ul className="space-y-1">
              {banks.items.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2 text-sm">
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs text-muted-foreground">{b.subjectName}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${b.status === "READY" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"}`}>
                    {b.status === "READY" ? "saved" : "draft"}
                  </span>
                  <span className="text-xs text-muted-foreground">{b.questionCount} question{b.questionCount === 1 ? "" : "s"}</span>
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => openBank(b.id)}>Open</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === "bank"}
                      aria-label={`Delete ${b.name}`} onClick={() => deleteBank(b.id, b.name, b.questionCount)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {banks && (banks.hasMore || filter.page > 1) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Button size="sm" variant="ghost" disabled={filter.page <= 1}
                onClick={() => setFilter((f) => ({ ...f, page: f.page - 1 }))}>Previous</Button>
              <span>Page {filter.page}</span>
              <Button size="sm" variant="ghost" disabled={!banks.hasMore}
                onClick={() => setFilter((f) => ({ ...f, page: f.page + 1 }))}>Next</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
