"use client";

// Attach a guardian account to THIS pupil.
//
// Linking already existed, on the Classes admin page, as a form with two
// searchable pickers — one for the guardian and one for the pupil. That is the
// right shape for a bulk session at the start of a year, and the wrong shape for
// the question that actually gets asked: "this child's mother is not getting the
// invoices, attach her". By then you are already on the child's record, looking
// at the list of who IS attached, and the pupil half of that form is a
// re-selection of the record you are standing on.
//
// So: one picker, here, beside the list it changes. The Classes form stays for
// the bulk case.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { UserPicker } from "@/components/people/UserPicker";
import { postSms } from "@/components/game/play-ui";

export function LinkGuardian({ studentId }: { studentId: string }) {
  const router = useRouter();
  const [parentId, setParentId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
      <div className="w-64">
        {/* Only accounts holding the parent role. The API enforces the same rule
            and says what to do when it refuses, rather than 500ing on a unique
            violation the way it used to. */}
        <UserPicker
          kind="parent"
          value={parentId}
          onChange={setParentId}
          placeholder="Search guardian accounts…"
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !parentId}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await postSms("guardians", { parentId, studentId });
          setBusy(false);
          if (res.ok) {
            setParentId("");
            // Server-rendered card: re-ask the server rather than guess.
            router.refresh();
            return;
          }
          setError(res.error ?? "Could not link that account.");
        }}
      >
        {busy ? "Linking…" : "Link guardian"}
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </div>
  );
}
