"use client";

import type { AdmissionApplicationDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { dateTime, titleCase } from "@/lib/format";
import { readApiError } from "@/lib/api-error";

export type Application = Serialized<AdmissionApplicationDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  NEW: "default",
  REVIEWING: "secondary",
  ACCEPTED: "secondary",
  REJECTED: "destructive",
};

export function AdmissionsReview({ apps }: { apps: Application[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const review = async (id: string, action: "APPROVE" | "REJECT") => {
    setBusy(id);
    setNote(null);
    const res = await fetch(`/api/sms/admissions/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setNote(res.status === 403 ? "You are not the approver for the current stage." : await readApiError(res));
  };

  const schedule = async (id: string, examDate: string, examNote: string) => {
    if (!examDate) return;
    setBusy(id);
    setNote(null);
    const res = await fetch(`/api/sms/admissions/${id}/exam`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examDate: new Date(examDate).toISOString(), examNote: examNote || undefined }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setNote(await readApiError(res));
  };

  return (
    <div className="space-y-2">
      {note && <p className="rounded-md bg-muted px-3 py-2 text-sm">{note}</p>}
      {apps.map((a) => (
        <AdmissionRow key={a.id} a={a} busy={busy === a.id} onReview={review} onSchedule={schedule} />
      ))}
    </div>
  );
}

function AdmissionRow({
  a,
  busy,
  onReview,
  onSchedule,
}: {
  a: Application;
  busy: boolean;
  onReview: (id: string, action: "APPROVE" | "REJECT") => void;
  onSchedule: (id: string, examDate: string, examNote: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [examDate, setExamDate] = React.useState(a.examDate ? a.examDate.slice(0, 10) : "");
  const [examNote, setExamNote] = React.useState(a.examNote ?? "");
  const terminal = a.status === "ACCEPTED" || a.status === "REJECTED";
  const d = a.details;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.childName}</span>
              <Badge variant={VARIANT[a.status] ?? "outline"}>{titleCase(a.status)}</Badge>
              {a.desiredClass && <Badge variant="outline">{a.desiredClass}</Badge>}
              {a.formFeeMinor > 0 &&
                (a.formFeePaidAt ? (
                  <Badge variant="secondary">Form fee paid</Badge>
                ) : (
                  <Badge variant="destructive">Form fee unpaid</Badge>
                ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {a.applicantName} · {a.applicantEmail}
              {a.applicantPhone ? ` · ${a.applicantPhone}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">{dateTime(a.createdAt)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">
              Stage {Math.min(a.currentStage + 1, a.stageCount)} / {a.stageCount}
            </p>
            {!terminal && a.stageLabel && <p className="text-sm font-medium">Awaiting: {a.stageLabel}</p>}
          </div>
        </div>

        {/* Maker-checker trail */}
        {a.approvals.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {a.approvals.map((ap, i) => (
              <Badge key={i} variant={ap.decision === "REJECT" ? "destructive" : "secondary"} className="text-[10px]">
                {ap.stageKey}: {ap.decision === "REJECT" ? "rejected" : "approved"}
              </Badge>
            ))}
          </div>
        )}

        <button onClick={() => setOpen(!open)} className="text-xs text-primary hover:underline">
          {open ? "Hide details" : "View application details"}
        </button>
        {open && d && (
          <div className="grid gap-1 rounded-md bg-muted/50 p-3 text-xs sm:grid-cols-2">
            <Field label="Parent" value={`${d.parentName} (${d.relationship ?? "guardian"})`} />
            <Field label="Parent email" value={d.parentEmail} />
            <Field label="Parent phone" value={d.parentPhone} />
            <Field label="Address" value={d.parentAddress} />
            <Field label="Child DOB" value={d.childDob} />
            <Field label="Gender" value={d.childGender} />
            <Field label="Desired class" value={d.desiredClass} />
            <Field label="Prior school" value={d.priorSchool} />
            {d.notes && <div className="sm:col-span-2"><Field label="Notes" value={d.notes} /></div>}
          </div>
        )}

        {!terminal && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button size="sm" disabled={busy} onClick={() => onReview(a.id, "APPROVE")}>
              Approve stage
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReview(a.id, "REJECT")}>
              Reject
            </Button>
            <span className="mx-1 text-xs text-muted-foreground">Entrance exam:</span>
            <Input
              type="date"
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
              className="h-8 w-40"
            />
            <Input
              placeholder="venue / note"
              value={examNote}
              onChange={(e) => setExamNote(e.target.value)}
              className="h-8 w-44"
            />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onSchedule(a.id, examDate, examNote)}>
              Save exam
            </Button>
          </div>
        )}

        {a.examDate && (
          <p className="text-xs text-muted-foreground">
            Entrance exam: {a.examDate.slice(0, 10)}
            {a.examNote ? ` · ${a.examNote}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <p>
      <span className="text-muted-foreground">{label}:</span> {value || "—"}
    </p>
  );
}
