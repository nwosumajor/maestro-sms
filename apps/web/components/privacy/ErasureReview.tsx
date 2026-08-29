"use client";

import type { ErasureRequestDto, Serialized } from "@sms/types";
import { useFormat } from "@/components/shell/RegionProvider";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { titleCase } from "@/lib/format";

export type ErasureRequest = Serialized<ErasureRequestDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "default",
  APPROVED: "secondary",
  REJECTED: "destructive",
};

export function ErasureReview({ requests }: { requests: ErasureRequest[] }) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { dateTime } = useFormat();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const review = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusy(id);
    setMsg(null);
    const res = await fetch(`/api/sms/privacy/erasure/${id}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
    });
    setBusy(null);
    if (res.ok) {
      // Say what actually happened. A refresh alone left the controller with no
      // idea whether a birth certificate had been erased or a report card kept —
      // and they are the person who has to answer the family.
      const out = (await res.json().catch(() => null)) as {
        erasedSubmissionFiles?: number;
        erasedSuppliedDocuments?: number;
        retainedVaultDocuments?: number;
        storageFailures?: number;
      } | null;
      if (out && decision === "APPROVED") {
        const erased = (out.erasedSubmissionFiles ?? 0) + (out.erasedSuppliedDocuments ?? 0);
        const parts = [`${erased} file${erased === 1 ? "" : "s"} erased`];
        if ((out.retainedVaultDocuments ?? 0) > 0) {
          parts.push(
            `${out.retainedVaultDocuments} school record${out.retainedVaultDocuments === 1 ? "" : "s"} retained ` +
              `(report cards, receipts, certificates)`,
          );
        }
        if ((out.storageFailures ?? 0) > 0) parts.push(`${out.storageFailures} could NOT be deleted — see the audit log`);
        setMsg(parts.join("; ") + ".");
      }
      router.refresh();
    }
  };

  return (
    <div className="space-y-2">
      {/* What the decision actually did — including what it deliberately kept. */}
      {msg && (
        <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground" role="status">
          {msg}
        </p>
      )}
      {requests.map((r) => (
        <Card key={r.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant={VARIANT[r.status] ?? "outline"}>{titleCase(r.status)}</Badge>
                {/* How long is left to answer. Red only once it is actually
                    late — a register that shouts at everything is one nobody
                    reads. */}
                {r.overdue && <Badge variant="destructive">Overdue</Badge>}
                <code className="text-xs text-muted-foreground">student {r.studentId.slice(0, 8)}…</code>
              </div>
              <p className="mt-0.5 text-sm">{r.reason}</p>
              <p className="text-xs text-muted-foreground">
                {dateTime(r.createdAt)}
                {r.daysRemaining !== null && (
                  <>
                    {" · "}
                    {/* The wording carries whether the date is the LAW or a
                        target. Saying "statutory deadline" for a regime whose
                        period nobody recorded would invent one. */}
                    {r.overdue
                      ? `${Math.abs(r.daysRemaining)} day${Math.abs(r.daysRemaining) === 1 ? "" : "s"} past the `
                      : `${r.daysRemaining} day${r.daysRemaining === 1 ? "" : "s"} left of the `}
                    {r.deadlineIsStatutory
                      ? `${r.targetDays}-day statutory deadline`
                      : `${r.targetDays}-day target (good practice — this regime's own period is not recorded)`}
                  </>
                )}
              </p>
            </div>
            {r.status === "PENDING" && (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === r.id} onClick={() => review(r.id, "APPROVED")}>Approve</Button>
                <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => review(r.id, "REJECTED")}>Reject</Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
