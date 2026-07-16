"use client";

// Admission-form fee setting (finance staff): what a PUBLIC applicant pays to
// submit an application to this school. 0 = free. Collected on the school's
// settlement split (platform take-rate applies) — the same rails as fees.

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function FormFeeCard({ initialMinor, canManage }: { initialMinor: number; canManage: boolean }) {
  const [major, setMajor] = React.useState(initialMinor > 0 ? String(initialMinor / 100) : "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    const n = major.trim() === "" ? 0 : Number(major);
    if (!Number.isFinite(n) || n < 0) return setMsg("Enter a valid amount (blank or 0 = free).");
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "admissions/settings/form-fee", { feeMinor: Math.round(n * 100) });
    setBusy(false);
    setMsg(res.ok ? (n > 0 ? "Saved — new applicants pay before review." : "Saved — applications are free.") : await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Admission form fee</CardTitle>
        <CardDescription>
          Charged to applicants when they submit the public application form; it settles to your bank like
          any online fee payment. Applications show a paid/unpaid chip below. Leave blank for free
          applications. Changing the fee never affects applications already submitted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canManage ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="aff-amount">Fee (₦)</Label>
              <Input
                id="aff-amount"
                className="tnum w-32"
                inputMode="decimal"
                placeholder="0 (free)"
                value={major}
                onChange={(e) => setMajor(e.target.value)}
              />
            </div>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save fee"}
            </Button>
            {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {initialMinor > 0
              ? `Applicants currently pay ${new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(initialMinor / 100)} per application.`
              : "Applications are currently free. A finance manager can set a form fee here."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
