"use client";

// Parent/teacher scholarship portal: browse OPEN programs, apply for a student,
// record guardian consent, and submit. Every action is server-scoped + audited.

import type { ScholarshipPortalDto, ScholarshipApplicationDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Portal = Serialized<ScholarshipPortalDto>;
type Application = Serialized<ScholarshipApplicationDto>;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "outline",
  SUBMITTED: "secondary",
  UNDER_REVIEW: "secondary",
  SHORTLISTED: "secondary",
  AWARDED: "default",
  REJECTED: "destructive",
};

export function ScholarshipPortal({ portal }: { portal: Portal }) {
  const router = useRouter();
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
                  <Badge variant="outline">{String(pr.selectionBasis).toLowerCase()}</Badge>
                </CardTitle>
                <CardDescription>
                  {pr.description || "Platform-sponsored scholarship."} · Closes {shortDate(pr.closesAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-2">
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
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* My applications */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">My applications</h2>
        {portal.applications.length === 0 && (
          <p className="text-sm text-muted-foreground">You haven&apos;t started any applications yet.</p>
        )}
        {portal.applications.map((a) => (
          <ApplicationRow key={a.id} app={a} busy={busy} run={run} />
        ))}
      </div>
    </div>
  );
}

function ApplicationRow({
  app,
  busy,
  run,
}: {
  app: Application;
  busy: string | null;
  run: (key: string, fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => Promise<void>;
}) {
  const consented = !!app.consentAt;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div>
          <p className="font-medium">
            {app.programTitle} <span className="text-muted-foreground">· {app.studentName}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {money(app.awardMinorOffered)} award · applied {shortDate(app.createdAt)}
            {app.status === "AWARDED" && app.awardMinor != null && ` · awarded ${money(app.awardMinor)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={(STATUS_TONE[app.status] ?? "outline") as never}>{app.status.replace(/_/g, " ")}</Badge>
          {app.status === "DRAFT" && (
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
      </CardContent>
    </Card>
  );
}
