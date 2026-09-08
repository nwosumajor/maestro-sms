// =============================================================================
// Correcting a school that was onboarded into the wrong country
// =============================================================================
// The region control existed — endpoint, its own permission, step-up, country
// catalogue, an editor component, a page, a link from the directory — and an
// operator reported being unable to find it. Two reasons, both real:
//
//   1. THE SCREEN COULD NOT SEE THE REGION. `SchoolProfileDto` carried no
//      `country`/`timezone`/`complianceRegime`, and the page reached for them
//      through `as unknown as { country?: string | null }` casts — the escape
//      hatch the type-safety spine exists to forbid. A cast turned "this DTO has
//      no country" from a compile error into a silent `undefined`, so a school
//      explicitly set to Ghana rendered as "platform default (Nigeria)". An
//      operator opening the screen to CORRECT a region could not see what it
//      was, which reads as the control not existing.
//
//   2. THE YEAR'S SHAPE DID NOT FOLLOW THE CORRECTION. Provisioning stamps
//      `calendarTemplate` FROM the country, so a school onboarded into the wrong
//      one carries that country's year shape. Everything else — timezone,
//      currency, locale, privacy regime — resolves from `country` when unset and
//      so corrected itself; the template is a stored column and stayed. Measured
//      live: onboarded as US (TWO_SEMESTER), corrected to Nigeria, still
//      TWO_SEMESTER in a three-term country, with nothing saying so.
//
// The realignment is deliberately NARROW. `calendarTemplate` is an escape hatch
// for "a school whose year does not match its region", so a template that
// differs from the OLD country's default was chosen by somebody and is left
// alone. Only a DERIVED one follows.
// =============================================================================

import { OperatorService } from "../../src/operator/operator.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = {
  schoolId: "platform",
  userId: "owner",
  roles: ["super_admin"],
  permissions: ["platform.tenants.region"],
};

function harness(school: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const client = {
    school: {
      findFirst: jest.fn().mockResolvedValue(school),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...school, ...data };
      }),
    },
  };
  // Constructor order matters: db, audit, entitlements, regions, privileged,
  // schoolStatus. A double must model the CONTRACT, not merely fill the arity.
  const svc = new OperatorService(
    { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) } as never,
    { record: jest.fn(async (e: Record<string, unknown>) => { audits.push(e); }) } as never,
    { resolve: jest.fn() } as never,
    { invalidate: jest.fn() } as never,
    { client } as never,
    { get: jest.fn() } as never,
  );
  return { svc, updates, audits, client };
}

describe("correcting a mis-onboarded country", () => {
  it("moves the YEAR'S SHAPE when nobody chose it", async () => {
    // Onboarded as US, so provisioning stamped the US default.
    const { svc, updates } = harness({ id: "s1", name: "Wrong Country School", country: "US", calendarTemplate: "TWO_SEMESTER" });
    await svc.setSchoolRegion(owner, "s1", { country: "NG" });
    expect(updates[0]).toMatchObject({ country: "NG", calendarTemplate: "THREE_TERM" });
  });

  it("LEAVES a template somebody chose — it is the escape hatch, not a derivation", async () => {
    // FOUR_QUARTER is not the US default, so it was a deliberate choice.
    const { svc, updates } = harness({ id: "s1", name: "Deliberate School", country: "US", calendarTemplate: "FOUR_QUARTER" });
    await svc.setSchoolRegion(owner, "s1", { country: "NG" });
    expect(updates[0].country).toBe("NG");
    expect(updates[0].calendarTemplate).toBeUndefined();
  });

  it("never overrides a template the caller supplied in the same request", async () => {
    const { svc, updates } = harness({ id: "s1", name: "S", country: "US", calendarTemplate: "TWO_SEMESTER" });
    await svc.setSchoolRegion(owner, "s1", { country: "NG", calendarTemplate: "FOUR_QUARTER" });
    expect(updates[0].calendarTemplate).toBe("FOUR_QUARTER");
  });

  it("does nothing to the template when the country is unchanged", async () => {
    const { svc, updates } = harness({ id: "s1", name: "S", country: "NG", calendarTemplate: "THREE_TERM" });
    await svc.setSchoolRegion(owner, "s1", { timezone: "Africa/Lagos" });
    expect(updates[0].calendarTemplate).toBeUndefined();
  });

  it("RECORDS a realignment nobody asked for — otherwise the trail cannot explain it", async () => {
    const { svc, audits } = harness({ id: "s1", name: "S", country: "US", calendarTemplate: "TWO_SEMESTER" });
    await svc.setSchoolRegion(owner, "s1", { country: "NG" });
    expect(audits[0].metadata).toMatchObject({ calendarTemplateRealignedTo: "THREE_TERM" });
  });

  it("an EMPTY STRING clears an override back to the country — the way out the UI now offers", async () => {
    // `.optional()` alone could not express this, and the confirm dialog names
    // it as the reason a country change leaves a timezone alone — so it has to
    // work, or the dialog is naming a way out that does not exist.
    const { svc, updates } = harness({ id: "s1", name: "S", country: "GH", calendarTemplate: "THREE_TERM" });
    await svc.setSchoolRegion(owner, "s1", { timezone: "", currency: "" });
    expect(updates[0]).toMatchObject({ timezone: null, currency: null });
  });

  it("refuses a country outside the catalogue rather than stamping it", async () => {
    const { svc } = harness({ id: "s1", name: "S", country: "NG", calendarTemplate: "THREE_TERM" });
    await expect(svc.setSchoolRegion(owner, "s1", { country: "ZZ" })).rejects.toThrow(/Unsupported country/);
  });
});
