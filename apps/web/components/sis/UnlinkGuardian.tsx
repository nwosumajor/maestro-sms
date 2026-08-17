"use client";

// Detach a guardian account from a pupil.
//
// The card this sits in could show that the wrong adult was attached to a child
// and offered nothing to do about it — there was no endpoint at all, so the only
// remedy was somebody running DELETE against the production database. A picker
// mis-click and a custody order both land here, and the second one is urgent.
//
// The only client-side thing on an otherwise server-rendered card: it is a
// button, so it is a client island, and nothing else needs to be.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { sendSms } from "@/components/game/play-ui";

export function UnlinkGuardian({
  studentId,
  parentId,
  guardianName,
}: {
  studentId: string;
  parentId: string;
  guardianName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Two steps, deliberately. This changes who can see a child's fees, grades,
  // attendance and report cards, and the row it sits on is one line high in a
  // table — a single misplaced click should not do it. Not a modal: a dialog
  // here would be one more thing to dismiss on the urgent path.
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Unlink
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Remove {guardianName}?</span>
      <Button
        variant="destructive"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await sendSms("DELETE", `guardians/${parentId}/${studentId}`);
          if (res.ok) {
            // Server-rendered card — refresh rather than mutate local state, so
            // what is on screen is what the server would send again.
            router.refresh();
            return;
          }
          setBusy(false);
          setConfirming(false);
          setError(res.error ?? "Could not remove the link.");
        }}
      >
        {busy ? "Removing…" : "Yes, remove"}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
