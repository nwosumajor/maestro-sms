"use client";

// =============================================================================
// RegionEditor — set a school's country, and everything that follows from it
// =============================================================================
// This had NO screen at all. The endpoint, its own permission, the country
// catalogue and the step-up gate were all built; nothing rendered them. So the
// only way to put a school in Ghana was an API call, and the manual told leaders
// to "ask support" because support was, literally, the mechanism.
//
// Deliberately blunt about consequences. Changing a region moves every register's
// day boundary, switches which privacy law applies, and can disable statutory
// payroll. That is not a dropdown you flip to see what happens.
// =============================================================================

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

type Country = {
  code: string;
  name: string;
  timezone: string;
  locale: string;
  currency: string;
  complianceRegime: string;
  payrollPack?: string | null;
};

export function RegionEditor({
  schoolId,
  schoolName,
  current,
  countries,
}: {
  schoolId: string;
  schoolName: string;
  current: { country?: string | null; timezone?: string | null; currency?: string | null; complianceRegime?: string | null };
  countries: Country[];
}) {
  const [code, setCode] = useState(current.country ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const picked = countries.find((c) => c.code === code);
  const changed = (current.country ?? "") !== code;

  async function save() {
    if (!picked) return;
    if (
      !window.confirm(
        `Move ${schoolName} to ${picked.name}?\n\n` +
          `• "Today" becomes ${picked.timezone} — every register's day boundary moves\n` +
          `• Money and dates display as ${picked.currency} / ${picked.locale}\n` +
          `• Privacy regime becomes ${picked.complianceRegime}\n` +
          (picked.payrollPack ? "" : "• Statutory payroll is NOT available there — runs will be refused\n"),
      )
    )
      return;
    setBusy(true);
    setNote(null);
    const res = await sendWithStepUp("PUT", `operator/tenants/${schoolId}/region`, { country: picked.code });
    setNote(res.ok ? `${schoolName} is now set to ${picked.name}.` : interpretApiError(res.status, await res.text()));
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Region</h2>
        <span className="text-xs text-muted-foreground">operator-set — never self-service</span>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        A school&rsquo;s country decides its timezone, currency, locale, privacy regime, academic calendar shape and
        whether statutory payroll is available. Schools cannot change this themselves, deliberately.
      </p>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label htmlFor="region-country" className="text-xs font-medium">
            Country
          </label>
          <select
            id="region-country"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-3 text-sm"
            disabled={busy}
          >
            <option value="">— platform default (Nigeria) —</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" className="h-8" disabled={!changed || !picked || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Change region"}
        </Button>
      </div>

      {picked && (
        <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
          <Badge variant="outline">{picked.timezone}</Badge>
          <Badge variant="outline">{picked.currency}</Badge>
          <Badge variant="outline">{picked.locale}</Badge>
          <Badge variant="secondary">{picked.complianceRegime}</Badge>
          {picked.payrollPack ? (
            <Badge variant="secondary">payroll: {picked.payrollPack}</Badge>
          ) : (
            <Badge variant="destructive">no statutory payroll</Badge>
          )}
        </div>
      )}

      {changed && picked && (
        <Alert variant="info" className="mb-2">
          <AlertTitle>This changes more than a label</AlertTitle>
          <AlertDescription className="text-xs">
            Registers already taken keep their dates, but from now on &ldquo;today&rdquo; means today in{" "}
            {picked.timezone}. The privacy regime becomes {picked.complianceRegime}
            {picked.payrollPack ? "" : ", and payroll runs will be refused rather than computed with the wrong tax rules"}.
          </AlertDescription>
        </Alert>
      )}

      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
