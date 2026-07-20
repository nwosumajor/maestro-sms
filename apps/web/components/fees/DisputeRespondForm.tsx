"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";

// Records the school's evidence response on an OPEN dispute (the evidence
// itself is submitted on the Paystack dashboard — this is the in-system record).
export function DisputeRespondForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await postSms(`fees/disputes/${disputeId}/respond`, { note: note.trim() });
    setBusy(false);
    if (res.ok) {
      setNote("");
      router.refresh();
    } else {
      setErr(res.error ?? "Failed.");
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        className="w-full rounded-md border bg-background p-2 text-sm"
        rows={2}
        placeholder="What evidence was submitted on the gateway dashboard (receipt, enrollment record, delivery proof…)?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !note.trim()} onClick={submit}>
          Record response
        </Button>
        {err && <span className="text-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}
