"use client";

// Comprehensive public onboarding intake. Collects the sales-qualifying detail
// the platform team needs to review + provision in one pass: school profile
// (type, location, website), approximate scale (students/staff — students also
// drive a LIVE per-seat price estimate from the same pricing endpoint checkout
// bills from), the contact person + their role, and the plan/module wish.
// Server-side zod re-validates everything; this form only saves round-trips.

import * as React from "react";
import {
  BILLING_CYCLES,
  CURRENCY_SYMBOL,
  CYCLE_DISCOUNT_PERCENT,
  CYCLE_MONTHS,
  MODULE_CATALOG,
  ONBOARDING_CONTACT_ROLES,
  ONBOARDING_SCHOOL_TYPES,
  PLANS,
  PLAN_MODULES,
  applyCycleDiscountMinor,
  defaultCurrencyFor,
  type BillingCycle,
  type ModuleKey,
  type Plan,
  type PlanPriceDto,
} from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const PLAN_LIST: Plan[] = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE];

const SCHOOL_TYPE_LABEL: Record<(typeof ONBOARDING_SCHOOL_TYPES)[number], string> = {
  PRIMARY: "Primary",
  SECONDARY: "Secondary",
  PRIMARY_AND_SECONDARY: "Primary & Secondary",
  TERTIARY: "Tertiary / College",
  OTHER: "Other",
};
const CONTACT_ROLE_LABEL: Record<(typeof ONBOARDING_CONTACT_ROLES)[number], string> = {
  PROPRIETOR: "Proprietor / Owner",
  PRINCIPAL: "Principal / Head of School",
  SCHOOL_ADMINISTRATOR: "School Administrator",
  IT_STAFF: "IT / Records Staff",
  OTHER: "Other",
};

const NG_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno",
  "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe",
  "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos",
  "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto",
  "Taraba", "Yobe", "Zamfara",
];

const sel = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

export function OnboardForm() {
  const [f, setF] = React.useState({
    schoolName: "",
    schoolType: "" as string,
    address: "",
    city: "",
    state: "",
    country: "Nigeria",
    website: "",
    studentCount: "",
    staffCount: "",
    contactName: "",
    contactRole: "" as string,
    contactEmail: "",
    contactPhone: "",
    desiredSlug: "",
    currentSystem: "",
    notes: "",
  });
  const [plan, setPlan] = React.useState<Plan>(PLANS.STANDARD);
  const [extras, setExtras] = React.useState<Set<ModuleKey>>(new Set());
  const inPlan = React.useMemo(() => new Set<ModuleKey>(PLAN_MODULES[plan]), [plan]);
  const addOnCatalog = MODULE_CATALOG.filter((m) => !inPlan.has(m.key));
  const changePlan = (next: Plan) => {
    setPlan(next);
    setExtras((prev) => new Set([...prev].filter((m) => !new Set(PLAN_MODULES[next]).has(m))));
  };
  const toggleExtra = (m: ModuleKey) =>
    setExtras((prev) => {
      const next = new Set(prev);
      next.has(m) ? next.delete(m) : next.add(m);
      return next;
    });

  // Live price estimate: students × the tier's per-seat monthly rate, from the
  // SAME public pricing endpoint checkout charges from (never a hardcoded price).
  const [pricing, setPricing] = React.useState<PlanPriceDto[] | null>(null);
  React.useEffect(() => {
    fetch("/api/public/plan-pricing")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: PlanPriceDto[] | null) => setPricing(rows))
      .catch(() => setPricing(null));
  }, []);
  const students = Number(f.studentCount) || 0;
  // Estimate in the tier's display currency (₦ locally, $ for ENTERPRISE) for the
  // chosen billing cycle, with the SAME commitment-discount rule checkout charges
  // (TERM 3 months −5%, YEAR 9 months −15%) — one shared function, no drift.
  const [cycle, setCycle] = React.useState<BillingCycle>(BILLING_CYCLES.TERM);
  const estCurrency = defaultCurrencyFor(plan);
  const perSeat = pricing?.find((r) => r.plan === plan && r.currency === estCurrency)?.perSeatMonthlyMinor ?? null;
  const estimate =
    perSeat != null && students > 0
      ? Math.round((applyCycleDiscountMinor(students * perSeat * CYCLE_MONTHS[cycle], cycle) / 100) * 100) / 100
      : null;
  const CYCLE_LABEL: Record<BillingCycle, string> = {
    MONTH: "Monthly",
    TERM: `Per term (3 months — save ${CYCLE_DISCOUNT_PERCENT.TERM}%)`,
    YEAR: `Per year (9 months — save ${CYCLE_DISCOUNT_PERCENT.YEAR}%)`,
  };
  const CYCLE_UNIT: Record<BillingCycle, string> = { MONTH: "month", TERM: "term", YEAR: "year" };

  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Friendly pre-check (the API re-validates): name every missing field.
    const missing: string[] = [];
    if (!f.schoolName.trim()) missing.push("school name");
    if (!f.schoolType) missing.push("school type");
    if (!f.address.trim()) missing.push("address");
    if (!f.city.trim()) missing.push("city/town");
    if (!f.state.trim()) missing.push("state");
    if (!f.country.trim()) missing.push("country");
    if (!Number(f.studentCount)) missing.push("number of students");
    if (!Number(f.staffCount)) missing.push("number of staff");
    if (!f.contactName.trim()) missing.push("your name");
    if (!f.contactRole) missing.push("your role");
    if (!f.contactEmail.trim()) missing.push("email");
    if (!f.contactPhone.trim()) missing.push("phone number");
    if (missing.length > 0) {
      setErr(`Please fill in: ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/public/onboarding-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schoolName: f.schoolName.trim(),
        schoolType: f.schoolType,
        address: f.address.trim(),
        city: f.city.trim(),
        state: f.state.trim(),
        country: f.country.trim(),
        website: f.website.trim() || undefined,
        studentCount: Number(f.studentCount),
        staffCount: Number(f.staffCount),
        contactName: f.contactName.trim(),
        contactRole: f.contactRole,
        contactEmail: f.contactEmail.trim(),
        contactPhone: f.contactPhone.trim(),
        desiredSlug: f.desiredSlug.trim() || undefined,
        desiredPlan: plan,
        desiredModules: [...extras],
        currentSystem: f.currentSystem.trim() || undefined,
        notes: f.notes.trim() || undefined,
      }),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setErr(`Something went wrong (${res.status}). Please check your details.`);
  };

  if (done) {
    return (
      <p className="text-sm">
        Thank you — your onboarding request has been received. Our team will review it and be in touch by
        email or phone to set up your school.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Section title="About your school">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="o-school">School name *</Label>
            <Input id="o-school" value={f.schoolName} onChange={set("schoolName")} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-type">School type *</Label>
            <select id="o-type" value={f.schoolType} onChange={set("schoolType")} className={sel} required>
              <option value="">Select…</option>
              {ONBOARDING_SCHOOL_TYPES.map((t) => (
                <option key={t} value={t}>{SCHOOL_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-web">Website <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="o-web" value={f.website} onChange={set("website")} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-slug">Preferred web address <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="o-slug" value={f.desiredSlug} onChange={set("desiredSlug")} placeholder="st-marys" />
          </div>
        </div>
      </Section>

      <Section title="Location">
        <div className="space-y-1.5">
          <Label htmlFor="o-addr">Street address *</Label>
          <Input id="o-addr" value={f.address} onChange={set("address")} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="o-city">City / town *</Label>
            <Input id="o-city" value={f.city} onChange={set("city")} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-state">State *</Label>
            {f.country.trim().toLowerCase() === "nigeria" ? (
              <select id="o-state" value={f.state} onChange={set("state")} className={sel} required>
                <option value="">Select…</option>
                {NG_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <Input id="o-state" value={f.state} onChange={set("state")} required />
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-country">Country *</Label>
            <Input id="o-country" value={f.country} onChange={set("country")} required />
          </div>
        </div>
      </Section>

      <Section title="School size">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="o-students">Number of students (approx.) *</Label>
            <Input id="o-students" type="number" min={1} max={200000} value={f.studentCount} onChange={set("studentCount")} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-staff">Number of staff (teaching + non-teaching) *</Label>
            <Input id="o-staff" type="number" min={1} max={50000} value={f.staffCount} onChange={set("staffCount")} required />
          </div>
        </div>
      </Section>

      <Section title="Contact person">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="o-name">Your name *</Label>
            <Input id="o-name" value={f.contactName} onChange={set("contactName")} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-role">Your role at the school *</Label>
            <select id="o-role" value={f.contactRole} onChange={set("contactRole")} className={sel} required>
              <option value="">Select…</option>
              {ONBOARDING_CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>{CONTACT_ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-email">Email *</Label>
            <Input id="o-email" type="email" value={f.contactEmail} onChange={set("contactEmail")} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-phone">Phone *</Label>
            <Input id="o-phone" type="tel" value={f.contactPhone} onChange={set("contactPhone")} required />
          </div>
        </div>
      </Section>

      <Section title="Plan & modules">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="o-plan">Plan</Label>
          <select id="o-plan" value={plan} onChange={(e) => changePlan(e.target.value as Plan)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
            {PLAN_LIST.map((pl) => (
              <option key={pl} value={pl}>{pl.charAt(0) + pl.slice(1).toLowerCase()}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{PLAN_MODULES[plan].length} modules included</span>
          <Label htmlFor="o-cycle" className="ml-2">Billing</Label>
          <select
            id="o-cycle"
            value={cycle}
            onChange={(e) => setCycle(e.target.value as BillingCycle)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {(Object.keys(CYCLE_LABEL) as BillingCycle[]).map((c) => (
              <option key={c} value={c}>{CYCLE_LABEL[c]}</option>
            ))}
          </select>
          {estimate != null && (
            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
              ≈ {CURRENCY_SYMBOL[estCurrency]}{estimate.toLocaleString("en-NG")}/{CYCLE_UNIT[cycle]} for {students.toLocaleString("en-NG")} students
              {CYCLE_DISCOUNT_PERCENT[cycle] > 0 && ` (${CYCLE_DISCOUNT_PERCENT[cycle]}% off)`}
            </span>
          )}
        </div>
        {addOnCatalog.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Extra modules you&apos;d like (beyond the {plan.charAt(0) + plan.slice(1).toLowerCase()} plan)
            </p>
            <div className="mt-1.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {addOnCatalog.map((m) => (
                <label key={m.key} className="flex items-center gap-1.5 text-sm" title={m.description}>
                  <input type="checkbox" checked={extras.has(m.key)} onChange={() => toggleExtra(m.key)} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section title="Anything else">
        <div className="space-y-1.5">
          <Label htmlFor="o-current">What do you use today? <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="o-current" value={f.currentSystem} onChange={set("currentSystem")} placeholder="Paper records, spreadsheets, another system…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-notes">Notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="o-notes" rows={3} value={f.notes} onChange={set("notes")} />
        </div>
      </Section>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Submitting…" : "Request onboarding"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Fields marked * are required. We review every request and get back to you within 1–2 working days.
      </p>
    </form>
  );
}
