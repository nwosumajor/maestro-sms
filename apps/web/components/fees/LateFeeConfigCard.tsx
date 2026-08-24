"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PLATFORM_HOME_CURRENCY, type LateFeeConfigDto } from "@sms/types";
import { sendWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useFormat } from "@/components/shell/RegionProvider";

/**
 * The school's money policy — late fee, approval threshold, library fine.
 *
 * All three are money figures IN THE SCHOOL'S OWN CURRENCY, and all three used
 * to be written in naira: the late fee was read and written with a literal 100
 * under a hard-coded "₦" label, while the other two were platform constants
 * with no screen at all. A school billing in pounds had a maker-checker rule
 * that never fired and a library fine of £50 a day, and no page from which to
 * discover or change either.
 *
 * Step-up gated, like every money-policy write here.
 */
export function LateFeeConfigCard({ initial }: { initial: LateFeeConfigDto }) {
  const router = useRouter();
  const { minorFrom, majorFrom, money } = useFormat();
  const cur = initial.currency || PLATFORM_HOME_CURRENCY;
  const isHome = cur.toUpperCase() === PLATFORM_HOME_CURRENCY;
  /** Blank box = "not set", which is a real and different answer from 0. */
  const asText = (minor: number | null) => (minor == null ? "" : String(majorFrom(minor, cur)));

  const [flat, setFlat] = React.useState(String(majorFrom(initial.lateFeeFlatMinor, cur)));
  const [grace, setGrace] = React.useState(String(initial.lateFeeGraceDays));
  const [threshold, setThreshold] = React.useState(asText(initial.paymentApprovalThresholdMinor));
  const [fine, setFine] = React.useState(asText(initial.libraryFinePerDayMinor));
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  /** "" means clear it (null); anything else is a figure in this currency. */
  const orNull = (v: string) => (v.trim() === "" ? null : minorFrom(v, cur));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "fees/late-fee-config", {
      lateFeeFlatMinor: minorFrom(flat, cur),
      lateFeeGraceDays: Number(grace),
      paymentApprovalThresholdMinor: orNull(threshold),
      libraryFinePerDayMinor: orNull(fine),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setMsg(body?.message ?? "Failed.");
    }
  };

  const num = "w-32 rounded-md border bg-background p-1.5 text-sm";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Money policy</CardTitle>
        <CardDescription>
          All amounts are in {cur}, this school&apos;s own currency. Step-up re-authentication is required to save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="w-full text-sm font-medium sm:w-auto" htmlFor="lf-amount">
            Automatic late fee
          </label>
          <input
            id="lf-amount"
            aria-label={`Late fee amount in ${cur}`}
            type="number"
            min="0"
            step="any"
            className={num}
            value={flat}
            onChange={(e) => setFlat(e.target.value)}
          />
          <label className="text-sm text-muted-foreground" htmlFor="lf-grace">
            after a grace of
          </label>
          <input
            id="lf-grace"
            aria-label="Grace period in days"
            type="number"
            min="0"
            max="90"
            className="w-24 rounded-md border bg-background p-1.5 text-sm"
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">days. 0 disables it.</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="w-full text-sm font-medium sm:w-auto" htmlFor="lf-threshold">
            A second approver is needed at
          </label>
          <input
            id="lf-threshold"
            aria-label={`Payment approval threshold in ${cur}`}
            type="number"
            min="0"
            step="any"
            className={num}
            placeholder="not set"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">
            and above. Currently {money(initial.effectiveApprovalThresholdMinor, cur)}
            {initial.paymentApprovalThresholdMinor == null &&
              (isHome
                ? " (the platform default)."
                : " — every payment is reviewed until you set a figure, because the default is written in " +
                  `${PLATFORM_HOME_CURRENCY} and cannot be converted to ${cur}.`)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="w-full text-sm font-medium sm:w-auto" htmlFor="lf-fine">
            Overdue library fine, per day
          </label>
          <input
            id="lf-fine"
            aria-label={`Library fine per day in ${cur}`}
            type="number"
            min="0"
            step="any"
            className={num}
            placeholder="not set"
            value={fine}
            onChange={(e) => setFine(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">
            Currently {money(initial.effectiveLibraryFinePerDayMinor, cur)}
            {initial.libraryFinePerDayMinor == null &&
              (isHome ? " (the platform default)." : " — no fine is charged until you set a rate.")}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={save}>
            Save
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
