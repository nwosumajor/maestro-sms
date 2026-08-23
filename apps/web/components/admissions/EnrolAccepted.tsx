"use client";

// =============================================================================
// Turning an accepted application into a pupil on the roll
// =============================================================================
// The last hand-keyed step in admissions. Everything before it — the form, the
// fee, the review chain, the entrance exam, the documents the family sent — was
// already in the system, and then somebody typed the child in again.
//
// TWO THINGS THIS SCREEN OWES THE PERSON PRESSING IT:
//
// The credentials appear ONCE and are never fetched again, because nothing
// stores a temporary password. So they are shown until dismissed, copyable, and
// the panel says plainly that closing it loses them — the same contract as the
// bulk import's login slips.
//
// And it does not offer the button for an application already enrolled. The API
// is idempotent and would simply hand back the same pupil, but a button that
// silently does nothing teaches people to press it twice.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";

type ClassOption = { id: string; name: string };
type Credentials = { name: string; email: string; tempPassword: string };

export function EnrolAccepted({
  applicationId,
  childName,
  classes,
  alreadyEnrolled,
}: {
  applicationId: string;
  childName: string;
  classes: ClassOption[];
  alreadyEnrolled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [classId, setClassId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<{ pupil?: Credentials; guardian?: Credentials } | null>(null);

  if (alreadyEnrolled) {
    return <span className="text-sm text-muted-foreground">Already enrolled</span>;
  }

  async function enrol() {
    setBusy(true);
    setError(null);
    const res = await postSms<{ credentials?: Credentials; guardianCredentials?: Credentials; alreadyConverted: boolean }>(
      `admissions/${applicationId}/convert`,
      { classId: classId || undefined },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    // A repeat press returns the pupil with no credentials — say so rather than
    // showing an empty panel.
    setIssued(
      res.data?.alreadyConverted
        ? {}
        : { pupil: res.data?.credentials, guardian: res.data?.guardianCredentials },
    );
    router.refresh();
  }

  if (issued) {
    return (
      <div className="w-full rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
        <p className="font-medium">{childName} is on the roll.</p>
        {!issued.pupil && <p className="mt-1 text-muted-foreground">This application had already been enrolled.</p>}
        {issued.pupil && (
          <>
            <p className="mt-2 text-muted-foreground">
              These sign-in details are shown <strong>once</strong>. Nothing stores a temporary password — write them
              down or hand them over before closing this.
            </p>
            <Slip label="Pupil" c={issued.pupil} />
            {issued.guardian && <Slip label="Guardian" c={issued.guardian} />}
            <p className="mt-2 text-xs text-muted-foreground">Both must set their own password at first sign-in.</p>
          </>
        )}
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setIssued(null)}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full">
      {error && <p className="mb-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      {!open ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          Enrol as pupil
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Class"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
          >
            {/* A class is optional: a pupil can be admitted before placement is
                settled, and forcing a choice here would push somebody into
                picking the wrong one. */}
            <option value="">No class yet</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy} onClick={enrol}>
            {busy ? "Enrolling…" : "Confirm"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function Slip({ label, c }: { label: string; c: Credentials }) {
  return (
    <div className="mt-2 rounded border border-border bg-background p-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium">{c.name}</p>
      <p className="tnum select-all break-all text-sm">{c.email}</p>
      <p className="tnum select-all text-sm">{c.tempPassword}</p>
    </div>
  );
}
