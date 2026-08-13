"use client";

// The leavers desk: who has left, what is still owed to them, and the one
// control that undoes a mistake.
//
// THIS PAGE CARRIES REAL WEIGHT NOW. A departed pupil is correctly gone from the
// student list, the pickers and search — so this is the ONLY route staff have to
// reach them. If it did not link through to the record, "they left" would also
// mean "you can never issue their transcript again", which is a worse problem
// than the one exiting solved. Every row therefore opens the profile, and the
// two documents a leaver is actually entitled to are one click away.
//
// RE-ADMIT IS PRINCIPAL-ONLY AND ONE STEP, on purpose. The two-stage chain
// exists to stop a single person REMOVING a child's access; restoring it is the
// safe direction, and making an undo as heavy as the mistake is how mistakes
// stay in place for a term. It restores ACCESS only — which class they rejoin is
// a decision, not a reversal, so the page says so rather than leaving staff to
// discover it from an empty roster.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { readApiError } from "@/lib/api-error";
import { sendWithStepUp } from "@/lib/stepup";
import { useFormat } from "@/components/shell/RegionProvider";

export type Leaver = {
  id: string;
  name: string;
  email: string;
  exitedAt: string | null;
  retentionDueAt: string | null;
  dueForReview: boolean;
  /** What they still owe. The figure the principal decides against. */
  outstandingMinor: number;
  docsReleased: boolean;
  /** Why they left — captured at the exit and, until now, never shown again. */
  exitKind: string | null;
  exitReason: string | null;
};

export function LeaversTable({
  rows,
  canReadmit,
  currency,
}: {
  rows: Leaver[];
  canReadmit: boolean;
  currency: string;
}) {
  const router = useRouter();
  const { shortDate, money } = useFormat();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const readmit = async (r: Leaver) => {
    const reason = window.prompt(`Re-admit ${r.name}? A short note for the record:`);
    if (reason === null) return; // cancelled
    setBusy(r.id);
    setMsg(null);
    const res = await fetch(`/api/sms/students/${r.id}/readmit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() || undefined }),
    });
    setBusy(null);
    if (res.ok) {
      setDone(r.name);
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  const setRelease = async (r: Leaver, released: boolean) => {
    const reason =
      window.prompt(
        released
          ? `Release ${r.name}'s documents? A short note for the record:`
          : `Withhold ${r.name}'s documents again? A short note for the record:`,
      ) ?? undefined;
    setBusy(r.id);
    setMsg(null);
    const res = await fetch(`/api/sms/students/${r.id}/documents/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released, reason: reason?.trim() || undefined }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(await readApiError(res));
  };

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No students have left.</p>;
  }

  return (
    <div className="space-y-2">
      {msg && <p className="text-sm text-destructive">{msg}</p>}
      {done && (
        <p className="text-sm text-muted-foreground">
          {done} can sign in again. They are not on any class list yet — enrol them from the class roster.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Left on</th>
              <th className="px-3 py-2 font-medium">Why</th>
              <th className="px-3 py-2 font-medium">Outstanding</th>
              <th className="px-3 py-2 font-medium">Documents</th>
              <th className="px-3 py-2 font-medium">Record kept until</th>
              <th className="px-3 py-2 font-medium">Documents</th>
              {canReadmit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  {/* The way back to the record. Without this the exit would
                      have made the pupil unreachable everywhere at once. */}
                  <Link href={`/students/${r.id}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">{r.email}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.exitedAt ? shortDate(r.exitedAt) : "—"}
                </td>
                {/* The school answered this when it approved the exit. It was
                    recorded and then never read back — the first question
                    anybody asks of a leavers list. */}
                <td className="px-3 py-2">
                  {r.exitKind ? (
                    <>
                      <span className="capitalize">{r.exitKind.toLowerCase()}</span>
                      {r.exitReason && (
                        <div className="text-xs text-muted-foreground">{r.exitReason}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                {/* What they owe, and what the principal has decided about it.
                    Side by side on purpose: the decision is made against the
                    figure, and putting them on different screens is how a
                    transcript gets released to somebody who owes a term's fees. */}
                <td className="px-3 py-2">
                  {r.outstandingMinor > 0 ? (
                    <span className="font-medium text-destructive">
                      {money(r.outstandingMinor, currency)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Nothing owed</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.docsReleased ? (
                    <Badge variant="secondary">Released</Badge>
                  ) : (
                    <Badge variant="outline" title="Transcripts, report cards and certificates are held">
                      Withheld
                    </Badge>
                  )}
                  {canReadmit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-2 h-7 px-2 text-xs"
                      disabled={busy === r.id}
                      onClick={() => setRelease(r, !r.docsReleased)}
                    >
                      {r.docsReleased ? "Withhold" : "Release"}
                    </Button>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.retentionDueAt ? (
                    r.dueForReview ? (
                      // "Review", never "delete". Nothing disposes of a child's
                      // academic record on a timer — a human decides.
                      <Badge variant="secondary" title="Past the school's retention window — due for a disposal decision">
                        Due for review
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{shortDate(r.retentionDueAt)}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">No limit set</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {/* What a leaver is actually entitled to ask for. Both paths
                      already existed and kept working after an exit; they were
                      simply unreachable once the pupil left every list. */}
                  <LeaverDocuments studentId={r.id} name={r.name} />
                </td>
                {canReadmit && (
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={busy === r.id}
                      onClick={() => readmit(r)}
                    >
                      {busy === r.id ? "Re-admitting…" : "Re-admit"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * How long this school keeps a leaver's record.
 *
 * Deliberately on THIS page rather than buried in a settings screen: the number
 * only means anything next to the list it governs, and an administrator who can
 * see "12 due for review" while setting it is far likelier to set it thoughtfully.
 */
export function RetentionPolicyCard({ years, canEdit }: { years: number; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = React.useState(String(years));
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    // Step-up gated on the API: changing how long a child's record is kept is
    // a records-disposal decision, not a preference. `sendWithStepUp` prompts
    // for the re-auth and forwards the token — a plain fetch would 401.
    const res = await sendWithStepUp("PUT", "students/exited/retention", { years: Number(value) });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        {years > 0
          ? `Leavers' records are kept for ${years} year${years === 1 ? "" : "s"} before being flagged for review.`
          : "No retention limit is set, so no leaver's record is ever flagged for review."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="retention-years">
            Keep a leaver&apos;s record for
          </label>
          <div className="flex items-center gap-2">
            <input
              id="retention-years"
              type="number"
              min={0}
              max={50}
              className="h-9 w-24 rounded-md border border-border bg-background px-2 text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">years</span>
          </div>
        </div>
        <Button onClick={save} disabled={busy || value === String(years)}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        This flags a record for a human to review — it never deletes anything. The statutory minimum differs
        by country, so set it to your own regulator&apos;s figure. Set 0 to turn the prompt off.
      </p>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

/**
 * The two documents a school owes a leaver.
 *
 * The transcript is a POST that streams a PDF — NOT something an `<a href>` can
 * fetch, which is exactly the trap: a plain link renders fine, looks correct in
 * review, and quietly does nothing when clicked. It reuses the same
 * blob-download the report-card button has always used rather than a second
 * implementation that can drift from it.
 */
function LeaverDocuments({ studentId, name }: { studentId: string; name: string }) {
  const [busy, setBusy] = React.useState<"pdf" | "json" | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || studentId;

  const transcript = async () => {
    setBusy("pdf");
    setMsg(null);
    const res = await fetch(`/api/sms/reportcards/${studentId}/generate`, { method: "POST" });
    setBusy(null);
    if (!res.ok) return setMsg(await readApiError(res));
    save(await res.blob(), `transcript-${slug}.pdf`);
  };

  const dataExport = async () => {
    setBusy("json");
    setMsg(null);
    const res = await fetch(`/api/sms/privacy/export/${studentId}`, { cache: "no-store" });
    setBusy(null);
    if (!res.ok) return setMsg(await readApiError(res));
    save(new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" }),
      `data-export-${slug}.json`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={transcript}>
        {busy === "pdf" ? "Preparing…" : "Transcript"}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={dataExport}>
        {busy === "json" ? "Preparing…" : "Data export"}
      </Button>
      {msg && <span className="text-xs text-destructive">{msg}</span>}
    </div>
  );
}
