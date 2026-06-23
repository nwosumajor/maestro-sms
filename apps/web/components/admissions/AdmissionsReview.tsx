"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { dateTime, titleCase } from "@/lib/format";

export interface Application {
  id: string;
  applicantName: string;
  applicantEmail: string;
  childName: string;
  status: string;
  createdAt: string;
}

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  NEW: "default", REVIEWING: "secondary", ACCEPTED: "secondary", REJECTED: "destructive",
};

export function AdmissionsReview({ apps }: { apps: Application[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const set = async (id: string, status: string) => {
    setBusy(id);
    const res = await fetch(`/api/sms/admissions/${id}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-2">
      {apps.map((a) => (
        <Card key={a.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{a.childName}</span>
                <Badge variant={VARIANT[a.status] ?? "outline"}>{titleCase(a.status)}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{a.applicantName} · {a.applicantEmail}</p>
              <p className="text-xs text-muted-foreground">{dateTime(a.createdAt)}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === a.id} onClick={() => set(a.id, "ACCEPTED")}>Accept</Button>
              <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => set(a.id, "REVIEWING")}>Reviewing</Button>
              <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => set(a.id, "REJECTED")}>Reject</Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
