"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MODULE_CATALOG, type OnboardingRequestDto, type Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Req = Serialized<OnboardingRequestDto>;

const MODULE_LABEL = new Map(MODULE_CATALOG.map((m) => [m.key as string, m.label]));

export function OnboardingRequests({ requests }: { requests: Req[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (id: string, status: "REVIEWING" | "APPROVED" | "REJECTED") => {
    setBusy(id + status);
    const res = await postSms(`operator/onboarding-requests/${id}/status`, { status });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  // Approve & provision: jump straight into the "Onboard a school" form above,
  // pre-filled from this request (name, slug, contact admin, plan + modules).
  // The provisioning POST carries the request id, so it flips to APPROVED when
  // the school is actually created — no separate approve click needed.
  const provision = (id: string) => {
    router.push(`/operator?provision=${id}`);
    // The Provisioning card sits at the top of the page.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const pending = requests.filter((r) => r.status === "NEW" || r.status === "REVIEWING");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onboarding requests ({pending.length} open)</CardTitle>
        <CardDescription>
          Prospective schools that asked to join from the public site. &ldquo;Approve &amp; provision&rdquo;
          pre-fills the onboarding form above with the request&apos;s details and plan/module wishes; the
          request flips to approved when the school is created.
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
                  {r.schoolType ? `· ${r.schoolType.replaceAll("_", " ").toLowerCase()} ` : ""}
                  {r.desiredSlug ? `· wants /${r.desiredSlug}` : ""}
                </span>
              </p>
              {(r.city || r.state || r.studentCount != null || r.staffCount != null) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[r.address, r.city, r.state, r.country].filter(Boolean).join(", ")}
                  {r.studentCount != null && ` · ~${r.studentCount.toLocaleString()} students`}
                  {r.staffCount != null && ` · ~${r.staffCount.toLocaleString()} staff`}
                  {r.website && ` · ${r.website}`}
                </p>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {r.contactName}
                {r.contactRole ? ` (${r.contactRole.replaceAll("_", " ").toLowerCase()})` : ""} · {r.contactEmail}
                {r.contactPhone ? ` · ${r.contactPhone}` : ""}
              </p>
              {(r.desiredPlan || (r.desiredModules?.length ?? 0) > 0) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Wants: {r.desiredPlan ? `${r.desiredPlan} plan` : "no tier picked"}
                  {(r.desiredModules?.length ?? 0) > 0 &&
                    ` + ${r.desiredModules!.map((m) => MODULE_LABEL.get(m) ?? m).join(", ")}`}
                </p>
              )}
              {r.currentSystem && <p className="mt-0.5 text-xs text-muted-foreground">Currently uses: {r.currentSystem}</p>}
              {r.notes && <p className="mt-0.5 text-xs text-muted-foreground">{r.notes}</p>}
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant={r.status === "APPROVED" ? "secondary" : r.status === "REJECTED" ? "destructive" : "outline"}>
                {r.status.toLowerCase()}
              </Badge>
              {(r.status === "NEW" || r.status === "REVIEWING") && (
                <>
                  <Button size="sm" className="h-7" onClick={() => provision(r.id)}>
                    Approve &amp; provision
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
