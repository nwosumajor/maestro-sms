"use client";

// =============================================================================
// LmsGradebook — pull aggregated LMS scores into the term report card (client)
// =============================================================================
// Two teacher tools for a class (grade.write, teacher-of-subject enforced by the
// API — 404 otherwise):
//   1. Tag a DRAFT quiz/assignment with a (subject, term) so it counts. Tagging
//      is only possible before approval; published items show a read-only tag.
//   2. Load the aggregated per-student score for a (subject, term) and APPLY it
//      into the report card's "assignment" CA slice — as a DRAFT the teacher
//      then publishes through the normal maker-checker chain. Nothing here is
//      auto-final (Golden Rule #8); the API is authoritative for every write.
// =============================================================================

import type { LmsContentDto, LmsGradebookDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Subject = { id: string; subjectId: string; subjectName: string; teacherName: string };
type Term = { id: string; name: string; sessionName: string };
type Content = Serialized<LmsContentDto>;
type Gradebook = Serialized<LmsGradebookDto>;
type Session = { id: string; name: string; terms: { id: string; name: string }[] };

async function req(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true, data, error: null };
  const j = data as { message?: string | string[] } | null;
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false, data: null, error };
}

export function LmsGradebook({ classId }: { classId: string }) {
  const router = useRouter();
  const [subjects, setSubjects] = React.useState<Subject[]>([]);
  const [terms, setTerms] = React.useState<Term[]>([]);
  const [gradable, setGradable] = React.useState<Content[]>([]);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const [s, ses, content] = await Promise.all([
      req("GET", `/classes/${classId}/subjects`),
      req("GET", `/academic/sessions`),
      req("GET", `/classes/${classId}/content`),
    ]);
    if (s.ok) setSubjects(s.data as Subject[]);
    if (ses.ok) {
      const flat: Term[] = [];
      for (const sess of (ses.data as Session[]) ?? []) {
        for (const t of sess.terms ?? []) flat.push({ id: t.id, name: t.name, sessionName: sess.name });
      }
      setTerms(flat);
    }
    if (content.ok) {
      setGradable(((content.data as Content[]) ?? []).filter((c) => c.type === "QUIZ" || c.type === "ASSIGNMENT"));
    }
    if (!s.ok || !ses.ok) setLoadErr("Couldn't load subjects/terms for this class.");
  }, [classId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <TagPanel classId={classId} subjects={subjects} terms={terms} gradable={gradable} onChanged={refresh} />
      <PullPanel classId={classId} subjects={subjects} terms={terms} onApplied={() => router.refresh()} />
      {loadErr && <p className="text-sm text-destructive">{loadErr}</p>}
    </div>
  );
}

// --- 1. Tag draft quizzes/assignments with a (subject, term) -----------------
function TagPanel({
  classId,
  subjects,
  terms,
  gradable,
  onChanged,
}: {
  classId: string;
  subjects: Subject[];
  terms: Term[];
  gradable: Content[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  async function tag(id: string, subjectId: string | null, termId: string | null) {
    setBusy(id);
    setErr(null);
    const r = await req("PUT", `/content/${id}`, { subjectId, termId });
    setBusy(null);
    if (r.ok) onChanged();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Count toward the report card</CardTitle>
        <CardDescription>
          Tag a quiz or assignment with a subject + term so its scores can be pulled into that term’s report
          card. You can only tag while it’s still a draft — published items show their tag read-only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {gradable.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quizzes or assignments in this class yet.</p>
        ) : (
          <div className="space-y-2">
            {gradable.map((c) => {
              const editable = c.status === "DRAFT" || c.status === "REVISION_REQUESTED";
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="min-w-[10rem] flex-1 font-medium">{c.title}</span>
                  <Badge variant="outline">{c.type === "QUIZ" ? "Quiz" : "Assignment"}</Badge>
                  {editable ? (
                    <>
                      <select
                        aria-label="Subject"
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={c.subjectId ?? ""}
                        disabled={busy === c.id}
                        onChange={(e) => tag(c.id, e.target.value || null, e.target.value ? c.termId : null)}
                      >
                        <option value="">— subject —</option>
                        {subjects.map((s) => (
                          <option key={s.subjectId} value={s.subjectId}>
                            {s.subjectName}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Term"
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={c.termId ?? ""}
                        disabled={busy === c.id || !c.subjectId}
                        onChange={(e) => tag(c.id, c.subjectId, e.target.value || null)}
                      >
                        <option value="">— term —</option>
                        {terms.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {t.sessionName}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : c.subjectId && c.termId ? (
                    <Badge variant="secondary">
                      {subjects.find((s) => s.subjectId === c.subjectId)?.subjectName ?? "Subject"} ·{" "}
                      {terms.find((t) => t.id === c.termId)?.name ?? "Term"}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">not counted</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

// --- 2. Pull aggregated LMS scores into the report card ----------------------
function PullPanel({
  classId,
  subjects,
  terms,
  onApplied,
}: {
  classId: string;
  subjects: Subject[];
  terms: Term[];
  onApplied: () => void;
}) {
  const [subjectId, setSubjectId] = React.useState("");
  const [termId, setTermId] = React.useState("");
  const [gb, setGb] = React.useState<Gradebook | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function load() {
    if (!subjectId || !termId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const r = await req("GET", `/classes/${classId}/lms-grades?subjectId=${subjectId}&termId=${termId}`);
    setBusy(false);
    if (r.ok) setGb(r.data as Gradebook);
    else {
      setGb(null);
      setErr(r.error);
    }
  }

  async function apply(studentIds?: string[]) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    const r = await req("POST", `/classes/${classId}/lms-grades/apply`, { subjectId, termId, studentIds });
    setBusy(false);
    if (r.ok) {
      const data = r.data as Gradebook;
      setGb(data);
      // SAY WHAT HAPPENED, not that something happened. A press that wrote
      // nothing used to read the same as one that wrote thirty marks, and a
      // press that sent published results back to draft — withdrawing that
      // subject from live report cards until it is approved again — said
      // nothing at all about it.
      const o = data.outcome;
      const why: string[] = [];
      if (o?.reasons.awaitingApproval) why.push(`${o.reasons.awaitingApproval} awaiting head-teacher/principal approval`);
      if (o?.reasons.notInClass) why.push(`${o.reasons.notInClass} no longer in the class or not offering the subject`);
      if (o?.reasons.unmarked) why.push(`${o.reasons.unmarked} with no marks to record`);
      if (o?.reasons.failed) why.push(`${o.reasons.failed} failed`);
      const parts = [
        o
          ? o.recorded === 0
            ? "No marks were recorded."
            : `Recorded ${o.recorded} draft CA mark${o.recorded === 1 ? "" : "s"}.`
          : "Applied as draft CA marks.",
        why.length ? `Skipped ${o?.skipped}: ${why.join("; ")}.` : "",
        o?.revertedFromPublished
          ? `${o.revertedFromPublished} previously published result${o.revertedFromPublished === 1 ? " is" : "s are"} now back in draft and off report cards until re-approved.`
          : "",
        o && o.recorded > 0 ? "Submit them for approval in the Gradebook (head-teacher → principal)." : "",
      ].filter(Boolean);
      setMsg(parts.join(" "));
      onApplied();
    } else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pull LMS scores into the report card</CardTitle>
        <CardDescription>
          Aggregates each student’s tagged, published quiz + assignment scores into a suggested mark for the
          assignment (CA) component. Applying writes a draft — you still publish it through the gradebook’s
          approval chain. Applying over marks that are already published sends that subject back to draft — it
          comes off report cards until the head teacher and principal approve it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <select
            aria-label="Subject"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
          >
            <option value="">Select subject…</option>
            {subjects.map((s) => (
              <option key={s.subjectId} value={s.subjectId}>
                {s.subjectName}
              </option>
            ))}
          </select>
          <select
            aria-label="Term"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
          >
            <option value="">Select term…</option>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.sessionName}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={load} disabled={!subjectId || !termId || busy}>
            {busy ? "Loading…" : "Load scores"}
          </Button>
        </div>

        {gb && (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-1.5 pr-2">Student</th>
                    <th className="px-2">Quizzes</th>
                    <th className="px-2">Assignments</th>
                    <th className="px-2">Overall</th>
                    <th className="px-2">Suggested CA (/{gb.componentMax})</th>
                    <th className="px-2">On report card</th>
                    <th className="px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {gb.rows.map((r) => (
                    <tr key={r.studentId} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">
                        {r.studentName}
                        {/* Says why "Apply all" will pass this pupil by. Their 0
                            is what shows you who has not done the work; it is not
                            a mark, and a bulk press must not file it as one. */}
                        {!r.participated && (
                          <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            not attempted
                          </span>
                        )}
                      </td>
                      <td className="px-2 tabular-nums">
                        {r.quizPossible > 0 ? `${round(r.quizEarned)}/${round(r.quizPossible)}` : "—"}
                      </td>
                      <td className="px-2 tabular-nums">
                        {r.assignmentPossible > 0 ? `${round(r.assignmentEarned)}/${round(r.assignmentPossible)}` : "—"}
                      </td>
                      <td className="px-2 tabular-nums">{r.percent === null ? "—" : `${r.percent}%`}</td>
                      <td className="px-2 tabular-nums font-semibold">{r.suggestedMark ?? "—"}</td>
                      <td className="px-2 tabular-nums">
                        {r.appliedMark === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span>
                            {r.appliedMark}{" "}
                            {r.resultStatus && (
                              <Badge variant={r.resultStatus === "PUBLISHED" ? "default" : "outline"} className="ml-1">
                                {r.resultStatus.toLowerCase()}
                              </Badge>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          disabled={busy || r.suggestedMark === null}
                          onClick={() => apply([r.studentId])}
                        >
                          Apply
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => apply()} disabled={busy}>
                Apply all to report card
              </Button>
              <span className="text-xs text-muted-foreground">
                Writes a draft assignment mark for every student who did the work. Pupils marked “not attempted” are
                skipped — use their own Apply button to record a zero deliberately.
              </span>
            </div>
          </div>
        )}

        {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
