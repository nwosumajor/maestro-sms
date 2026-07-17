"use client";

// Scholarship portal — three hats in one, decided by the caller's role:
//   STUDENT  — request a scholarship with the detailed form (reason, skills,
//              achievements, …); the request then walks the approval chain:
//              class supervisor → parent/guardian (approval = consent) →
//              principal → the platform sponsor. A timeline shows every stage.
//   PARENT / TEACHER / PRINCIPAL — decide the requests waiting at THEIR stage
//              (relationship-verified server-side), plus the legacy
//              apply-on-behalf flow for parents/teachers.
// Every action is server-scoped + audited; everyone is notified at each stage.

import type { ScholarshipPortalDto, ScholarshipApplicationDto, ScholarshipRequestForm, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, shortDate } from "@/lib/format";

type Portal = Serialized<ScholarshipPortalDto>;
type Application = Serialized<ScholarshipApplicationDto>;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "outline",
  PENDING_SUPERVISOR: "secondary",
  PENDING_PARENT: "secondary",
  PENDING_PRINCIPAL: "secondary",
  SUBMITTED: "secondary",
  UNDER_REVIEW: "secondary",
  SHORTLISTED: "secondary",
  QUALIFIED: "default",
  AWARDED: "default",
  REJECTED: "destructive",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_SUPERVISOR: "With class supervisor",
  PENDING_PARENT: "Awaiting parent approval",
  PENDING_PRINCIPAL: "With the principal",
  SUBMITTED: "With the sponsor",
  UNDER_REVIEW: "Under sponsor review",
  SHORTLISTED: "Shortlisted",
  QUALIFIED: "Qualified for exam",
  AWARDED: "Awarded",
  REJECTED: "Rejected",
};

/** Which decision the CALLER makes for an app sitting in pendingDecisions. */
const STAGE_PROMPT: Record<string, string> = {
  PENDING_SUPERVISOR: "As the class supervisor, approve or reject this request.",
  PENDING_PARENT: "As the parent/guardian, approving ALSO consents to sharing your child's academic record with the sponsor.",
  PENDING_PRINCIPAL: "As the principal, this is the final school approval before the sponsor.",
};

const FORM_FIELDS: Array<{ key: keyof ScholarshipRequestForm; label: string; required?: boolean; hint?: string }> = [
  { key: "reason", label: "Reason for the scholarship request", required: true, hint: "Why do you need this scholarship? Be specific." },
  { key: "skills", label: "Skills", hint: "e.g. coding, debating, football, music…" },
  { key: "achievements", label: "Achievements & awards" },
  { key: "extracurricular", label: "Clubs & extracurricular activities" },
  { key: "futureGoals", label: "Future goals" },
];

export function ScholarshipPortal({ portal, roles }: { portal: Portal; roles: string[] }) {
  const router = useRouter();
  const isStudent = roles.includes("student");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [studentFor, setStudentFor] = React.useState<Record<string, string>>({});

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => {
    setBusy(key);
    setMsg(null);
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      setMsg({ ok: true, text: okText });
      router.refresh();
    } else {
      setMsg({ ok: false, text: res.error ?? "Request failed." });
    }
  };

  const appliedFor = (programId: string) => new Set(portal.applications.filter((a) => a.programId === programId).map((a) => a.studentId));

  return (
    <div className="space-y-6">
      {msg && (
        <p className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-muted text-foreground" : "border border-destructive/40 bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}

      {/* Requests awaiting MY decision (supervisor / parent / principal) */}
      {portal.pendingDecisions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Awaiting your decision</h2>
          {portal.pendingDecisions.map((a) => (
            <DecisionCard key={a.id} app={a} busy={busy} run={run} />
          ))}
        </div>
      )}

      {/* OPEN programs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Open scholarships</h2>
        {portal.programs.length === 0 && (
          <p className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No scholarships are open for applications right now. Check back soon.
          </p>
        )}
        {portal.programs.map((pr) => {
          const already = appliedFor(pr.id);
          const pickable = portal.students.filter((s) => !already.has(s.id));
          const chosen = studentFor[pr.id] ?? pickable[0]?.id ?? "";
          return (
            <Card key={pr.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {pr.title}
                  <Badge variant="secondary">{money(pr.awardMinor)} award</Badge>
                  <Badge variant="outline">{String(pr.category).replaceAll("_", " ").toLowerCase()}</Badge>
                </CardTitle>
                <CardDescription>
                  {pr.description || "Platform-sponsored scholarship."} · Closes {shortDate(pr.closesAt)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isStudent ? (
                  pickable.length === 0 ? (
                    <p className="text-sm text-muted-foreground">You&apos;ve already requested this scholarship — track it below.</p>
                  ) : (
                    <StudentRequestForm programId={pr.id} studentId={pickable[0].id} busy={busy} run={run} />
                  )
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    {portal.students.length === 0 ? (
                      <p className="text-sm text-muted-foreground">You have no students to apply for.</p>
                    ) : pickable.length === 0 ? (
                      <p className="text-sm text-muted-foreground">You&apos;ve applied for all your students on this scholarship.</p>
                    ) : (
                      <>
                        <select
                          aria-label="Student"
                          value={chosen}
                          onChange={(e) => setStudentFor((s) => ({ ...s, [pr.id]: e.target.value }))}
                          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        >
                          {pickable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <Button
                          disabled={busy === `apply-${pr.id}` || !chosen}
                          onClick={() => run(`apply-${pr.id}`, () => sendSms("POST", "scholarships/applications", { programId: pr.id, studentId: chosen }), "Application started — give consent and submit below.")}
                        >
                          Apply
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* My applications / requests */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{isStudent ? "My scholarship requests" : "My applications"}</h2>
        {portal.applications.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {isStudent ? "You haven't requested a scholarship yet." : "You haven't started any applications yet."}
          </p>
        )}
        {portal.applications.map((a) => (
          <ApplicationRow key={a.id} app={a} isStudent={isStudent} busy={busy} run={run} />
        ))}
      </div>
    </div>
  );
}

// --- Student: the detailed request form ---------------------------------------
function StudentRequestForm({
  programId,
  studentId,
  busy,
  run,
}: {
  programId: string;
  studentId: string;
  busy: string | null;
  run: (key: string, fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string>>({});
  if (!open) {
    return <Button onClick={() => setOpen(true)}>Request this scholarship</Button>;
  }
  const submit = () =>
    run(
      `request-${programId}`,
      async () => {
        // Create the request with the form, then submit it into the chain.
        const created = await sendSms("POST", "scholarships/applications", { programId, studentId, answers: form });
        if (!created.ok) return created;
        const id = (created as { data?: { id?: string } }).data?.id;
        if (!id) return { ok: false, error: "Could not create the request." };
        return sendSms("POST", `scholarships/applications/${id}/submit`);
      },
      "Request submitted — your class supervisor has been notified. Track every stage below.",
    );
  return (
    <div className="w-full space-y-3">
      <p className="text-xs text-muted-foreground">
        Your profile, class, published grades, attendance, discipline record and completed tasks are attached
        automatically. Tell us the rest:
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FORM_FIELDS.map((f) => (
          <div key={f.key} className={`space-y-1.5 ${f.key === "reason" ? "sm:col-span-2" : ""}`}>
            <Label htmlFor={`sf-${programId}-${f.key}`}>
              {f.label} {f.required && "*"}
            </Label>
            {f.key === "reason" ? (
              <textarea
                id={`sf-${programId}-${f.key}`}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={f.hint}
                required
              />
            ) : (
              <Input
                id={`sf-${programId}-${f.key}`}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                placeholder={f.hint}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={busy === `request-${programId}` || !(form.reason ?? "").trim()} onClick={submit}>
          Submit request
        </Button>
        <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        After you submit: class supervisor → parent/guardian → principal → the scholarship sponsor. You&apos;ll be
        notified at every stage.
      </p>
    </div>
  );
}

// --- A request awaiting the caller's stage decision ---------------------------
function DecisionCard({
  app,
  busy,
  run,
}: {
  app: Application;
  busy: string | null;
  run: (key: string, fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => Promise<void>;
}) {
  const [note, setNote] = React.useState("");
  const form = (app.answers ?? {}) as Partial<ScholarshipRequestForm>;
  const sig = app.signals;
  const decide = (decision: "APPROVE" | "REJECT") =>
    run(
      `${decision}-${app.id}`,
      () => sendSms("POST", `scholarships/applications/${app.id}/decision`, { decision, note: note.trim() || undefined }),
      decision === "APPROVE" ? "Approved — the next stage has been notified." : "Rejected — the student and guardians have been notified.",
    );
  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {app.studentName}
          <span className="text-muted-foreground">·</span> {app.programTitle}
          <Badge variant="secondary">{STATUS_LABEL[app.status] ?? app.status}</Badge>
        </CardTitle>
        <CardDescription>{STAGE_PROMPT[app.status]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {form.reason && (
          <p className="text-sm">
            <span className="font-semibold">Reason:</span> {form.reason}
          </p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {form.skills && <span><span className="font-medium text-foreground">Skills:</span> {form.skills}</span>}
          {form.achievements && <span><span className="font-medium text-foreground">Achievements:</span> {form.achievements}</span>}
          {form.extracurricular && <span><span className="font-medium text-foreground">Extracurricular:</span> {form.extracurricular}</span>}
          {form.futureGoals && <span><span className="font-medium text-foreground">Goals:</span> {form.futureGoals}</span>}
        </div>
        {sig && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {sig.classNames && sig.classNames.length > 0 && <span>Class: {sig.classNames.join(", ")}</span>}
            {sig.publishedSessionAverage != null && <span>Grade avg: {sig.publishedSessionAverage}%</span>}
            {sig.attendanceRatePct != null && <span>Attendance: {sig.attendanceRatePct}%</span>}
            <span>Outstanding fees: {money(sig.outstandingFeesMinor)}</span>
            {sig.disciplineComplaints != null && <span>Discipline complaints: {sig.disciplineComplaints}</span>}
            {sig.tasksCompleted != null && <span>Tasks completed: {sig.tasksCompleted}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the record…"
            className="h-9 w-64"
          />
          <Button size="sm" disabled={busy === `APPROVE-${app.id}`} onClick={() => decide("APPROVE")}>
            Approve
          </Button>
          <Button size="sm" variant="destructive" disabled={busy === `REJECT-${app.id}`} onClick={() => decide("REJECT")}>
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- One of my applications, with the chain timeline --------------------------
function ChainTimeline({ app }: { app: Application }) {
  // Only student-chain applications walk the stages.
  if (app.applicantRole !== "student") return null;
  const steps: Array<{ label: string; done: boolean; note: string | null; failedHere: boolean }> = [
    { label: "Class supervisor", done: !!app.supervisorAt, note: app.supervisorNote, failedHere: app.rejectedStage === "SUPERVISOR" },
    { label: "Parent/guardian", done: !!app.consentAt, note: app.parentNote, failedHere: app.rejectedStage === "PARENT" },
    { label: "Principal", done: !!app.principalAt, note: app.principalNote, failedHere: app.rejectedStage === "PRINCIPAL" },
    {
      label: "Sponsor",
      done: ["QUALIFIED", "AWARDED"].includes(app.status),
      note: app.reviewNote,
      failedHere: app.rejectedStage === "PLATFORM",
    },
  ];
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          {i > 0 && <span aria-hidden className="text-muted-foreground/50">→</span>}
          <li
            title={s.note ?? undefined}
            className={
              s.failedHere
                ? "rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                : s.done
                  ? "rounded-full bg-brand2/10 px-2 py-0.5 font-medium text-brand2"
                  : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
            }
          >
            {s.failedHere ? "✕ " : s.done ? "✓ " : ""}{s.label}
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

function ApplicationRow({
  app,
  isStudent,
  busy,
  run,
}: {
  app: Application;
  isStudent: boolean;
  busy: string | null;
  run: (key: string, fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => Promise<void>;
}) {
  const consented = !!app.consentAt;
  const legacyDraft = app.status === "DRAFT" && app.applicantRole !== "student";
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">
              {app.programTitle} {!isStudent && <span className="text-muted-foreground">· {app.studentName}</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              {money(app.awardMinorOffered)} award · applied {shortDate(app.createdAt)}
              {app.status === "AWARDED" && app.awardMinor != null && ` · awarded ${money(app.awardMinor)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={(STATUS_TONE[app.status] ?? "outline") as never}>{STATUS_LABEL[app.status] ?? app.status.replace(/_/g, " ")}</Badge>
            {legacyDraft && (
              <>
                {!consented && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === `consent-${app.id}`}
                    onClick={() => run(`consent-${app.id}`, () => sendSms("POST", `scholarships/applications/${app.id}/consent`), "Consent recorded — you can submit now.")}
                  >
                    Give guardian consent
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy === `submit-${app.id}` || !consented}
                  title={consented ? "Submit for review" : "A guardian must consent first"}
                  onClick={() => run(`submit-${app.id}`, () => sendSms("POST", `scholarships/applications/${app.id}/submit`), "Submitted for review.")}
                >
                  Submit
                </Button>
              </>
            )}
          </div>
        </div>
        <ChainTimeline app={app} />
        {app.status === "QUALIFIED" && (
          <p className="mt-2 rounded-md bg-brand2/10 px-3 py-2 text-xs font-medium text-brand2">
            🎓 Qualified for the scholarship exam — the exam date, category and mode arrive in your Notifications.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
