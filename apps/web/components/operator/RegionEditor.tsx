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
  // WHAT IT IS NOW, resolved for display. An operator opening this screen is
  // usually here to CORRECT a region, and the first thing they need is what it
  // is currently set to — which this could not show while the DTO carried no
  // country, so a Ghanaian school read as "platform default (Nigeria)".
  const now = countries.find((c) => c.code === (current.country ?? ""));

  /**
   * CLEAR ONE OVERRIDE back to whatever the country says.
   *
   * The confirm dialog now names these as the reason a country change will not
   * move the timezone or the currency — so there has to be a way to act on
   * that. A message naming a way out that does not exist is the defect it was
   * written to avoid. The API has always supported it: an EMPTY STRING clears a
   * field to null, which `.optional()` alone could not express.
   */
  async function clearOverride(field: "timezone" | "currency" | "complianceRegime", label: string) {
    if (!window.confirm(`Clear the ${label} override for ${schoolName}?\n\nIt will follow the school's country from now on.`))
      return;
    setBusy(true);
    setNote(null);
    const res = await sendWithStepUp("PUT", `operator/tenants/${schoolId}/region`, { [field]: "" });
    setNote(
      res.ok
        ? `${label} override cleared — ${schoolName} now follows its country. Reload to see the new value.`
        : interpretApiError(res.status, await res.text()),
    );
    setBusy(false);
  }

  async function save() {
    if (!picked) return;
    // TELL THE TRUTH ABOUT WHAT WILL ACTUALLY CHANGE.
    //
    // This promised that "today" becomes the new country's timezone and that
    // money displays in its currency — unconditionally. Both are false when the
    // school carries an EXPLICIT override, because those columns win over the
    // country and a country change does not clear them. Measured: a school with
    // timezone Africa/Accra and currency GHS moved to Kenya kept both, while the
    // dialog said each would change. A confirmation that asserts an outcome
    // which does not happen is the same failure as a refusal that asserts
    // something untrue.
    const lines = [
      current.timezone
        ? `• "Today" stays ${current.timezone} — this school has an explicit timezone override, which the country does not replace`
        : `• "Today" becomes ${picked.timezone} — every register's day boundary moves`,
      current.currency && current.currency !== picked.currency
        ? `• Families are still billed in ${current.currency} — an explicit fee-currency override, not replaced by the country`
        : `• Money and dates display as ${picked.currency} / ${picked.locale}`,
      current.complianceRegime
        ? `• Privacy regime stays ${current.complianceRegime} — explicitly set, not replaced by the country`
        : `• Privacy regime becomes ${picked.complianceRegime}`,
    ];
    if (!picked.payrollPack) lines.push("• Statutory payroll is NOT available there — runs will be refused");
    if (current.timezone || current.currency || current.complianceRegime)
      lines.push("\nClear an override to let the country decide it — see the badges above.");
    if (
      !window.confirm(
        `Move ${schoolName} from ${now?.name ?? "the platform default (Nigeria)"} to ${picked.name}?\n\n` +
          lines.join("\n"),
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

      {/* CURRENTLY SET TO — stated before the control that changes it. */}
      <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Currently set to</p>
        <p className="mt-0.5 text-sm font-medium">
          {now ? now.name : current.country ? current.country : "No country set — the platform default (Nigeria) applies"}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
          {/* An explicit override is shown as such: a school can sit in a country
              and still bill in another currency, and hiding that makes the
              editor look wrong to whoever set it deliberately. */}
          {current.timezone && (
            <span className="inline-flex items-center gap-1">
              <Badge variant="outline">timezone override: {current.timezone}</Badge>
              <button
                type="button"
                onClick={() => void clearOverride("timezone", "timezone")}
                disabled={busy}
                className="text-xs text-primary underline disabled:opacity-50"
              >
                clear
              </button>
            </span>
          )}
          {current.currency && (
            <span className="inline-flex items-center gap-1">
              <Badge variant="outline">bills families in {current.currency}</Badge>
              <button
                type="button"
                onClick={() => void clearOverride("currency", "fee currency")}
                disabled={busy}
                className="text-xs text-primary underline disabled:opacity-50"
              >
                clear
              </button>
            </span>
          )}
          {current.complianceRegime && (
            <span className="inline-flex items-center gap-1">
              <Badge variant="secondary">{current.complianceRegime}</Badge>
              <button
                type="button"
                onClick={() => void clearOverride("complianceRegime", "privacy regime")}
                disabled={busy}
                className="text-xs text-primary underline disabled:opacity-50"
              >
                clear
              </button>
            </span>
          )}
          {!current.timezone && !current.currency && !current.complianceRegime && (
            <span className="text-muted-foreground">everything follows the country — no overrides</span>
          )}
        </div>
      </div>

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
