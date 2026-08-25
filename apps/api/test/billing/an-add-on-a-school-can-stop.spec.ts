// =============================================================================
// One field meaning two things, and a charge nobody could stop
// =============================================================================
// `overrides.enabled` held BOTH a module the school BOUGHT as an add-on and a
// module the OPERATOR comped. They are not the same thing and they answer the
// delinquency question differently — but stored identically, they answered it
// identically, so a school that stopped paying lost fifteen tier modules and
// kept every add-on it had ever bought. Proved live: ULTIMATE, 400 days past
// due, effective plan STANDARD, hostel still on. An add-on is billed AT
// RENEWAL, and there had been no renewal.
//
// AND THERE WAS NO WAY OUT. Nothing in the API removed a module from
// `overrides.enabled`: a school could start a recurring charge in one click and
// the only exit was an operator hand-editing the subscription JSON.
//
// Cancelling does NOT switch the module off on the spot. The last charge
// covered this period — prorated at purchase, in full at each renewal — so the
// school keeps what it paid for until `currentPeriodEnd`, `billableAddons`
// stops charging immediately, and the renewal that rolls the period drops it.
// =============================================================================

import {
  MODULES,
  PLANS,
  billableAddons,
  dropCancelledAddons,
  overridesUnderDelinquency,
  resolveModules,
} from "@sms/types";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";

const BOUGHT = { enabled: [MODULES.HOSTEL], purchased: [MODULES.HOSTEL] };
const COMPED = { enabled: [MODULES.HOSTEL] }; // an operator toggle marks nothing purchased

describe("a paid add-on and a comped one are not the same thing", () => {
  it("both switch the module on while the subscription is healthy", () => {
    expect(resolveModules(PLANS.STANDARD, BOUGHT)).toContain(MODULES.HOSTEL);
    expect(resolveModules(PLANS.STANDARD, COMPED)).toContain(MODULES.HOSTEL);
  });

  it("DELINQUENCY withdraws the one the school pays for", () => {
    // The tier already fell to the floor; the add-on is billed at renewal and
    // there has been no renewal. Losing one and keeping the other is not a
    // policy, it is the two being indistinguishable.
    expect(resolveModules(PLANS.STANDARD, overridesUnderDelinquency(BOUGHT))).not.toContain(MODULES.HOSTEL);
  });

  it("and KEEPS the one the operator gave", () => {
    // A comp is the platform owner's decision about this school, not something
    // the school failed to do. Dunning silently reversing it would surprise the
    // person who made it.
    expect(resolveModules(PLANS.STANDARD, overridesUnderDelinquency(COMPED))).toContain(MODULES.HOSTEL);
  });

  it("never touches a force-OFF", () => {
    const off = { enabled: [], disabled: [MODULES.LIBRARY], purchased: [] };
    expect(resolveModules(PLANS.STANDARD, overridesUnderDelinquency(off))).not.toContain(MODULES.LIBRARY);
  });
});

describe("the ENTITLEMENT SERVICE actually applies it", () => {
  // The helper existing is not the same as being called. Every one of the pure
  // cases above passes with the service still resolving against the raw
  // overrides — mutation-checked, and it did.
  const resolveFor = async (row: Record<string, unknown>) => {
    const svc = new ModuleEntitlementService(
      {
        runAsTenant: async (_c: unknown, fn: (tx: unknown) => unknown) =>
          fn({ schoolSubscription: { findFirst: async () => row } }),
      } as never,
    );
    return svc.resolve("school-1");
  };

  const paid = {
    plan: PLANS.ULTIMATE,
    status: "ACTIVE",
    billingCycle: "TERM",
    overrides: { enabled: [MODULES.ALUMNI], purchased: [MODULES.ALUMNI] },
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    graceDays: null,
    seats: 100,
    priceMinor: 1,
    currency: "NGN",
  };

  it("keeps a purchased add-on while the school is paying", async () => {
    const r = await resolveFor(paid);
    expect(r.effectivePlan).toBe(PLANS.ULTIMATE);
    expect(r.modules).toContain(MODULES.ALUMNI);
  });

  it("withdraws it once delinquency has dropped the tier", async () => {
    // 400 days past due: `effectivePlan` falls to the floor. The add-on used to
    // survive that, so the school kept what it had stopped paying for.
    const lapsed = {
      ...paid,
      status: "PAST_DUE",
      currentPeriodEnd: new Date(Date.now() - 400 * 86_400_000),
    };
    const r = await resolveFor(lapsed);
    expect(r.effectivePlan).toBe(PLANS.STANDARD);
    expect(r.modules).not.toContain(MODULES.ALUMNI);
    // The stored overrides are UNCHANGED — the withdrawal is a resolution rule,
    // not a write. Paying restores the module with no repair step, exactly as
    // paying restores the tier.
    expect(r.overrides.enabled).toContain(MODULES.ALUMNI);
  });

  it("keeps a COMPED module through the same lapse", async () => {
    const comped = {
      ...paid,
      overrides: { enabled: [MODULES.ALUMNI] },
      status: "PAST_DUE",
      currentPeriodEnd: new Date(Date.now() - 400 * 86_400_000),
    };
    const r = await resolveFor(comped);
    expect(r.effectivePlan).toBe(PLANS.STANDARD);
    expect(r.modules).toContain(MODULES.ALUMNI);
  });
});

describe("cancelling an add-on", () => {
  const CANCELLED = { enabled: [MODULES.HOSTEL], purchased: [MODULES.HOSTEL], cancelling: [MODULES.HOSTEL] };

  it("stops the billing at once", () => {
    // `billableAddons` prices every quote, checkout and auto-renew charge, so
    // excluding it here IS "stop billing me".
    expect(billableAddons(PLANS.STANDARD, BOUGHT)).toContain(MODULES.HOSTEL);
    expect(billableAddons(PLANS.STANDARD, CANCELLED)).not.toContain(MODULES.HOSTEL);
  });

  it("leaves the module ON until the paid period runs out", () => {
    // Taking it away the moment they click would forfeit time already paid for.
    expect(resolveModules(PLANS.STANDARD, CANCELLED)).toContain(MODULES.HOSTEL);
  });

  it("actually removes it when the period rolls over", () => {
    // The other half. Without this the module stays on for ever, free, and the
    // cancellation is a promise nobody kept.
    const after = dropCancelledAddons(CANCELLED);
    expect(after.enabled).not.toContain(MODULES.HOSTEL);
    expect(after.purchased).not.toContain(MODULES.HOSTEL);
    expect(after.cancelling).toEqual([]);
    expect(resolveModules(PLANS.STANDARD, after)).not.toContain(MODULES.HOSTEL);
  });

  it("leaves overrides alone when nothing is cancelling", () => {
    // A renewal must not rewrite a subscription that had no cancellation.
    expect(dropCancelledAddons(BOUGHT)).toEqual(BOUGHT);
  });

  it("does not disturb a module the TIER includes", () => {
    // ULTIMATE contains hostel. Cancelling the add-on cannot take away what the
    // plan itself grants.
    expect(resolveModules(PLANS.ULTIMATE, dropCancelledAddons(CANCELLED))).toContain(MODULES.HOSTEL);
  });
});
