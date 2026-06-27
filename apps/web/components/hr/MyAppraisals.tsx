"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AppraisalDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Appraisal = Serialized<AppraisalDto>;

export function MyAppraisals({ appraisals }: { appraisals: Appraisal[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  if (appraisals.length === 0) return null;

  const acknowledge = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/sms/hr/appraisals/${id}/acknowledge`, { method: "POST" });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">My appraisals</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {appraisals.map((a) => (
          <div key={a.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{a.period}{a.overallRating != null ? ` · ${a.overallRating}/5` : ""}</span>
              <span className="flex items-center gap-2">
                <Badge variant={a.status === "ACKNOWLEDGED" ? "default" : "secondary"}>{a.status}</Badge>
                {a.status === "SUBMITTED" && <Button size="sm" disabled={busy === a.id} onClick={() => acknowledge(a.id)}>Acknowledge</Button>}
              </span>
            </div>
            {a.summary && <p className="mt-1 text-muted-foreground">{a.summary}</p>}
            {a.goals && <p className="mt-1 text-muted-foreground">Goals: {a.goals}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
