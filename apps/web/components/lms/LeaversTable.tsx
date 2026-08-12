"use client";

// The leavers list, plus the one control that undoes a mistake.
//
// RE-ADMIT IS PRINCIPAL-ONLY AND ONE STEP, on purpose. The two-stage chain
// exists to stop a single person REMOVING a child's access. Restoring it is the
// safe direction, and making an undo as heavy as the mistake is how mistakes
// stay in place for a term.
//
// It restores ACCESS and nothing else — which class they rejoin is a decision
// somebody has to make, not a reversal, so the page says so rather than leaving
// staff to discover it from an empty roster.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";
import { useFormat } from "@/components/shell/RegionProvider";

type Leaver = { id: string; name: string; email: string; exitedAt: string | null };

export function LeaversTable({ rows, canReadmit }: { rows: Leaver[]; canReadmit: boolean }) {
  const router = useRouter();
  const { shortDate } = useFormat();
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
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Left on</th>
              {canReadmit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.email}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.exitedAt ? shortDate(r.exitedAt) : "—"}
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
