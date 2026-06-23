"use client";

import type { ErasureRequestDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { dateTime, titleCase } from "@/lib/format";

export type ErasureRequest = Serialized<ErasureRequestDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "default",
  APPROVED: "secondary",
  REJECTED: "destructive",
};

export function ErasureReview({ requests }: { requests: ErasureRequest[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const review = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusy(id);
    const res = await fetch(`/api/sms/privacy/erasure/${id}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-2">
      {requests.map((r) => (
        <Card key={r.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant={VARIANT[r.status] ?? "outline"}>{titleCase(r.status)}</Badge>
                <code className="text-xs text-muted-foreground">student {r.studentId.slice(0, 8)}…</code>
              </div>
              <p className="mt-0.5 text-sm">{r.reason}</p>
              <p className="text-xs text-muted-foreground">{dateTime(r.createdAt)}</p>
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
