"use client";

// =============================================================================
// What a person still owes the school, and what they have already sent
// =============================================================================
// ONE component for both sides — a pupil's admission documents and a new
// colleague's onboarding papers are the same screen with different words, and a
// second copy is how the two drift apart.
//
// The number that matters is MISSING MANDATORY. Everything else is context: an
// optional immunisation record left blank must not make a file look unfinished
// for ever, because an indicator that is always amber stops being read.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import type { SubmissionChecklistDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";
import { uploadDocument } from "@/lib/upload-document";

type Checklist = Serialized<SubmissionChecklistDto>;

const STATUS_STYLE: Record<string, string> = {
  UPLOADED: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  VERIFIED: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  REJECTED: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  WAIVED: "bg-muted text-muted-foreground",
  PENDING: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const STATUS_WORD: Record<string, string> = {
  UPLOADED: "Received",
  VERIFIED: "Checked",
  REJECTED: "Refused",
  WAIVED: "Waived",
  PENDING: "Not finished",
};

export function DocumentChecklist({
  subjectKind,
  subjectId,
  initial,
  canDecide,
}: {
  subjectKind: string;
  subjectId: string;
  initial: Checklist;
  /** The API decides this too; the UI simply does not offer what would be
   *  refused — a button that always 403s is worse than no button. */
  canDecide: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [waiving, setWaiving] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  async function decide(id: string, status: "VERIFIED" | "REJECTED") {
    // A refusal has to say why: the family sees it, and without a reason they
    // send the same file again.
    const why = status === "REJECTED" ? window.prompt("Why is this being refused? The family will see this.") : undefined;
    if (status === "REJECTED" && !why?.trim()) return;
    setBusy(id);
    setError(null);
    const res = await postSms(`documents/submissions/${id}/decide`, { status, reason: why });
    setBusy(null);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  /**
   * The office's own copy of a document.
   *
   * A family sends most of these through their link, and then somebody walks
   * into the office with a paper certificate. Without this the only way in was
   * the emailed link — so a registrar holding the actual document had nowhere to
   * put it, which is how paper ends up in a drawer instead of on the record.
   *
   * Same uploader, same three steps, same server checks. The only difference is
   * who is asking, and the API records that: a file added here carries the
   * member of staff who added it, where a family's carries nobody.
   */
  async function attach(requirementId: string | null, file: File) {
    const id = requirementId ?? "other";
    setBusy(id);
    setError(null);
    const out = await uploadDocument(file, {
      ticketUrl: "/api/sms/documents/submissions/upload-url",
      confirmUrl: (submissionId) => `/api/sms/documents/submissions/${submissionId}/confirm`,
      body: { subjectKind, subjectId, requirementId },
    });
    setBusy(null);
    if (out.ok) router.refresh();
    else setError(out.error);
  }

  async function waive(requirementId: string) {
    if (!reason.trim()) return;
    setBusy(requirementId);
    setError(null);
    const res = await postSms("documents/submissions/waive", { subjectKind, subjectId, requirementId, reason });
    setBusy(null);
    if (res.ok) {
      setWaiving(null);
      setReason("");
      router.refresh();
    } else setError(res.error);
  }

  const { progress, outstanding, submissions } = initial;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documents</CardTitle>
        <CardDescription>
          {progress.required === 0
            ? "This school has not said what it asks for yet."
            : progress.complete
              ? `Everything required is in — ${progress.satisfied} of ${progress.required}.`
              : `${progress.missingMandatory} still needed — ${progress.satisfied} of ${progress.required} in.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        {outstanding.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Still to come</p>
            {outstanding.map((r) => (
              <div key={r.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.label}</span>
                  {r.mandatory ? (
                    <span className="rounded px-1.5 py-0.5 text-[11px] bg-amber-500/15 text-amber-600 dark:text-amber-400">Required</span>
                  ) : (
                    <span className="rounded px-1.5 py-0.5 text-[11px] bg-muted text-muted-foreground">Optional</span>
                  )}
                  {canDecide && waiving !== r.id && (
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setWaiving(r.id); setReason(""); }}>
                      Waive
                    </Button>
                  )}
                </div>
                {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
                {canDecide && (
                  <input
                    type="file"
                    className="mt-2 block w-full text-sm"
                    accept="application/pdf,image/jpeg,image/png"
                    disabled={busy === r.id}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void attach(r.id, file);
                      e.target.value = "";
                    }}
                  />
                )}
                {waiving === r.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                      placeholder="Why will this never arrive?"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <Button size="sm" disabled={!reason.trim() || busy === r.id} onClick={() => waive(r.id)}>
                      {busy === r.id ? "Saving…" : "Waive it"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setWaiving(null)}>Cancel</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {submissions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sent in</p>
            {submissions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.requirementLabel ?? s.originalName ?? "Document"}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.uploadedAt ? shortDate(s.uploadedAt) : shortDate(s.createdAt)}
                    {/* Who sent it matters: a null uploader is the family or the
                        candidate themselves, which is the normal case here. */}
                    {s.uploadedByUserId ? " · added by staff" : " · sent in"}
                    {s.verifiedByName ? ` · checked by ${s.verifiedByName}` : ""}
                  </p>
                  {s.rejectedReason && <p className="mt-1 text-sm text-rose-600 dark:text-rose-400">{s.rejectedReason}</p>}
                </div>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[s.status] ?? "bg-muted"}`}>
                  {STATUS_WORD[s.status] ?? s.status}
                </span>
                <div className="ml-auto flex gap-2">
                  {/* Only a real file can be opened. A waiver has no bytes by
                      definition, and a refused one had its bytes thrown away. */}
                  {s.status !== "WAIVED" && s.status !== "REJECTED" && s.status !== "PENDING" && (
                    <a
                      className="text-sm underline underline-offset-4"
                      href={`/api/sms/documents/submissions/${s.id}/file`}
                    >
                      Open
                    </a>
                  )}
                  {canDecide && (s.status === "UPLOADED" || s.status === "REJECTED") && (
                    <>
                      <Button size="sm" disabled={busy === s.id} onClick={() => decide(s.id, "VERIFIED")}>
                        {busy === s.id ? "…" : "Accept"}
                      </Button>
                      {s.status === "UPLOADED" && (
                        <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => decide(s.id, "REJECTED")}>
                          Refuse
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {canDecide && progress.required > 0 && (
          <div className="rounded-md border border-dashed border-border p-3">
            <p className="text-sm font-medium">Something else</p>
            <p className="text-xs text-muted-foreground">
              A document the school did not ask for but should keep. It satisfies nothing on the list.
            </p>
            <input
              type="file"
              className="mt-2 block w-full text-sm"
              accept="application/pdf,image/jpeg,image/png"
              disabled={busy === "other"}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attach(null, file);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {submissions.length === 0 && outstanding.length === 0 && progress.required > 0 && (
          <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
        )}
      </CardContent>
    </Card>
  );
}
