"use client";

// "Refer a school" panel on /billing. Shows the school's shareable referral
// code + link (generated on demand, billing.manage) and the conversions earned.
// The reward itself is granted server-side by the billing webhook when the
// referred school's first paid subscription lands — this panel is read/share UI.

import type { ReferralInfoDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { interpretApiError } from "@/lib/api-error";
import { shortDate } from "@/lib/format";

type Info = Serialized<ReferralInfoDto>;

export function ReferralPanel({ initial, canManage }: { initial: Info; canManage: boolean }) {
  const [info, setInfo] = React.useState<Info>(initial);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<"code" | "link" | null>(null);

  const shareLink = info.code
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/onboard?ref=${encodeURIComponent(info.code)}`
    : null;

  const generate = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/sms/billing/referral/code", { method: "POST" });
    setBusy(false);
    if (res.ok) setInfo((await res.json()) as Info);
    else {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(interpretApiError(res.status, body?.message ?? null));
    }
  };

  const copy = async (what: "code" | "link", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr("Couldn't copy — select and copy the text manually.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refer a school</CardTitle>
        <CardDescription>
          Know a school that should be here? When they subscribe using your code, BOTH schools get one
          school term (3 months) of platform usage free — yours on your current plan, theirs on the plan
          they choose.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {info.code ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-sm font-semibold tracking-wide">
                {info.code}
              </span>
              <Button variant="outline" size="sm" onClick={() => copy("code", info.code!)}>
                {copied === "code" ? "Copied ✓" : "Copy code"}
              </Button>
              {shareLink && (
                <Button variant="outline" size="sm" onClick={() => copy("link", shareLink)}>
                  {copied === "link" ? "Copied ✓" : "Copy share link"}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Share the link — it opens the public onboarding form with your code already filled in.
            </p>
          </div>
        ) : canManage ? (
          <Button onClick={generate} disabled={busy}>
            {busy ? "Generating…" : "Get my referral code"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            No referral code yet — a billing manager (principal or school admin) can generate one here.
          </p>
        )}

        {err && <p className="text-sm text-destructive">{err}</p>}

        <div>
          <p className="mb-2 text-sm font-medium">
            Referrals earned{info.conversions.length > 0 ? ` (${info.conversions.length})` : ""}
          </p>
          {info.conversions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Each successful referral extends your subscription by a free term.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {info.conversions.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span>
                    <span className="font-medium">{c.referredSchoolName}</span>{" "}
                    <span className="text-muted-foreground">· {shortDate(c.convertedAt)}</span>
                  </span>
                  <span className="font-medium text-brand2">
                    +{c.rewardMonths} months free → {shortDate(c.newPeriodEnd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
