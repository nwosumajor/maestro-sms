"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { OnboardingRequestDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Req = Serialized<OnboardingRequestDto>;

export function OnboardingRequests({ requests }: { requests: Req[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (id: string, status: "REVIEWING" | "APPROVED" | "REJECTED") => {
    setBusy(id + status);
    const res = await postSms(`operator/onboarding-requests/${id}/status`, { status });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  const pending = requests.filter((r) => r.status === "NEW" || r.status === "REVIEWING");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onboarding requests ({pending.length} open)</CardTitle>
        <CardDescription>
          Prospective schools that asked to join from the public site. Approve, then create the tenant with the
          form above (school admin + principal).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {requests.length === 0 && <p className="text-sm text-muted-foreground">No requests.</p>}
        {requests.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {r.schoolName}{" "}
                <span className="font-normal text-muted-foreground">
                  · {r.contactName} · {r.contactEmail}
                  {r.contactPhone ? ` · ${r.contactPhone}` : ""}
                  {r.desiredSlug ? ` · wants /${r.desiredSlug}` : ""}
                </span>
              </p>
              {r.notes && <p className="mt-0.5 text-xs text-muted-foreground">{r.notes}</p>}
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant={r.status === "APPROVED" ? "secondary" : r.status === "REJECTED" ? "destructive" : "outline"}>
                {r.status.toLowerCase()}
              </Badge>
              {(r.status === "NEW" || r.status === "REVIEWING") && (
                <>
                  <Button size="sm" variant="outline" className="h-7" disabled={busy === r.id + "APPROVED"} onClick={() => act(r.id, "APPROVED")}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7" disabled={busy === r.id + "REJECTED"} onClick={() => act(r.id, "REJECTED")}>
                    Reject
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
