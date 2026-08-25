// =============================================================================
// A tier change that silently deleted every add-on
// =============================================================================
// `setSubscription` read `input.overrides?.enabled ?? []` and wrote the result
// on EVERY call — while `status` and `currentPeriodEnd`, in the same object
// literal fifteen lines below, correctly treat an omitted field as "leave it
// alone". `plan` is required on every PUT, so ANY operator save that did not
// resend the toggles wiped every module the school had bought and every module
// the operator had comped.
//
// Proved live: a school on ULTIMATE with a purchased hostel add-on, saved as
// `{plan: "PREMIUM"}`, came back with `overrides.enabled: []`.
//
// The console always sends the toggles it last read, so the UI never showed it
// — but that is also a LOST UPDATE: an add-on bought while the operator has the
// page open is erased by their next save, and the school stops having something
// it paid for with nothing on any screen saying why.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { OperatorService } from "../../src/operator/operator.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const OWNER: Principal = {
  userId: "owner",
  schoolId: "platform",
  roles: ["super_admin"],
  permissions: ["platform.subscription.manage"],
};
const SCHOOL = "school-1";

function makeService(existingOverrides: unknown) {
  const update = jest.fn().mockResolvedValue({});
  const create = jest.fn().mockResolvedValue({});
  const tx = {
    school: { findFirst: jest.fn().mockResolvedValue({ id: SCHOOL }) },
    schoolSubscription: {
      findFirst: jest.fn().mockResolvedValue({ id: "sub-1", plan: "ULTIMATE", overrides: existingOverrides }),
      update,
      create,
    },
    auditLog: { create: jest.fn() },
  };
  const svc = Object.create(OperatorService.prototype) as OperatorService;
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    entitlements: {
      invalidate: jest.fn(),
      resolve: jest.fn().mockResolvedValue({ plan: "PREMIUM", effectivePlan: "PREMIUM", overrides: {}, modules: [] }),
      dtoFrom: jest.fn().mockReturnValue({}),
    },
  });
  return { svc, update, create };
}

const BOUGHT = { enabled: ["hostel"], disabled: [], purchased: ["hostel"] };

describe("an operator changing a school's tier", () => {
  it("does NOT touch the overrides when it was not asked to", async () => {
    const { svc, update } = makeService(BOUGHT);
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM" });
    expect(update).toHaveBeenCalledTimes(1);
    // The field must be ABSENT from the write, not written as an empty set.
    expect(Object.keys(update.mock.calls[0][0].data)).not.toContain("overrides");
    expect(update.mock.calls[0][0].data.plan).toBe("PREMIUM");
  });

  it("writes them when it WAS asked to", async () => {
    const { svc, update } = makeService(BOUGHT);
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM", overrides: { enabled: ["alumni"], disabled: [] } });
    // Hostel is gone because the operator removed it — and with it the purchase
    // marker, which only ever qualifies something still enabled.
    expect(update.mock.calls[0][0].data.overrides).toEqual({
      enabled: ["alumni"],
      disabled: [],
      purchased: [],
      cancelling: [],
    });
  });

  it("CARRIES THE PURCHASE MARKER through a write that keeps the module", async () => {
    // The console sends `enabled` and `disabled` and has no notion of a
    // purchase. Rebuilding the object from those two fields alone erased
    // `purchased`, quietly turning every paid add-on into a comp — which then
    // survives delinquency for ever, the exact hole that marker exists to close.
    // My own first fix did this, and the live probe caught it.
    const { svc, update } = makeService(BOUGHT);
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM", overrides: { enabled: ["hostel", "alumni"], disabled: [] } });
    expect(update.mock.calls[0][0].data.overrides.purchased).toEqual(["hostel"]);
  });

  it("clears them when asked to clear them", async () => {
    // An EMPTY object is a decision — "this school has no overrides" — and must
    // still be obeyed. Only an ABSENT field means "leave it alone".
    const { svc, update } = makeService(BOUGHT);
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM", overrides: {} });
    expect(update.mock.calls[0][0].data.overrides).toEqual({
      enabled: [],
      disabled: [],
      purchased: [],
      cancelling: [],
    });
  });

  it("still drops a module key it does not recognise", async () => {
    const { svc, update } = makeService(BOUGHT);
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM", overrides: { enabled: ["hostel", "not-a-module"] } });
    expect(update.mock.calls[0][0].data.overrides.enabled).toEqual(["hostel"]);
    expect(update.mock.calls[0][0].data.overrides.purchased).toEqual(["hostel"]);
  });

  it("gives a NEW subscription an empty set rather than nothing", async () => {
    // A row that does not exist yet has no overrides to preserve, so "omitted"
    // cannot mean "unchanged" there — it means empty.
    const { svc, create } = makeService(BOUGHT);
    (svc as unknown as { db: { runAsTenant: jest.Mock } }).db.runAsTenant = jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) =>
      fn({
        school: { findFirst: jest.fn().mockResolvedValue({ id: SCHOOL }) },
        schoolSubscription: { findFirst: jest.fn().mockResolvedValue(null), create, update: jest.fn() },
      }),
    );
    await svc.setSubscription(OWNER, SCHOOL, { plan: "PREMIUM" });
    expect(create.mock.calls[0][0].data.overrides).toEqual({ enabled: [], disabled: [] });
  });

  it("still refuses a plan that is not one", async () => {
    const { svc } = makeService(BOUGHT);
    await expect(svc.setSubscription(OWNER, SCHOOL, { plan: "GOLD" })).rejects.toBeInstanceOf(BadRequestException);
  });
});
