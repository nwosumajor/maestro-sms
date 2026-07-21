"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Serialized, VirtualAccountDto } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The student's dedicated bank account for fee transfers: display when one
// exists; finance staff can provision one when it doesn't (idempotent
// server-side). Transfers to it credit the oldest open invoice automatically.
export function VirtualAccountCard({
  studentId,
  initial,
  canManage,
}: {
  studentId: string;
  initial: Serialized<VirtualAccountDto> | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  if (!initial && !canManage) return null;

  const provision = async () => {
    setBusy(true);
    setErr(null);
    const res = await postSms(`students/${studentId}/virtual-account`);
    setBusy(false);
    if (res.ok) router.refresh();
    else setErr(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Pay by bank transfer</CardTitle>
        <CardDescription>
          {initial
            ? "Transfers to this dedicated account credit the oldest unpaid invoice automatically."
            : "Assign this student a dedicated bank account number for fee transfers."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {initial ? (
          <p className="text-sm">
            <span className="tnum font-mono text-lg font-semibold">{initial.accountNumber}</span>{" "}
            <span className="text-muted-foreground">· {initial.bankName}</span>
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={provision}>
              {busy ? "Provisioning…" : "Create dedicated account"}
            </Button>
            {err && <span className="text-sm text-destructive">{err}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
