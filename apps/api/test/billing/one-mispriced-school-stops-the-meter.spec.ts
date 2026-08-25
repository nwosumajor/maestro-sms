// =============================================================================
// One school's pricing problem stopped metering the whole fleet
// =============================================================================
// The nightly sweep meters seat growth — students carried above the seats a
// school paid for — onto `seatArrearsMinor`, and that is the platform's only
// record of revenue it has earned and not yet billed.
//
// The loop sat inside a SINGLE try/catch. The first school that threw abandoned
// every school after it, the failure was one warn line naming nobody, and
// `DunningResult.failed` — which the operator's jobs console reads to decide its
// "Partial" badge — knew nothing about it at all. So the console showed a clean
// green run while the platform metered no seat growth whatsoever.
//
// REACHABLE, and proved on the running stack rather than argued: a school sold
// in a currency `CURRENCIES` supports but which has no `plan_price` rows makes
// `PlanPricingService.effective` REFUSE — deliberately, since quoting a tier at
// zero is worse than saying the market is not open yet. Two schools, one of them
// GHS: BOTH accrued nothing, and the sweep returned `failed: 0`.
//
// Third instance of the lesson already recorded for the retention and dunning
// sweeps — and this is the loop directly ABOVE the per-school guard those fixes
// added, which is exactly how it was missed.
// =============================================================================

import { BillingDunningService } from "../../src/billing/billing-dunning.service";

const NOW = new Date("2026-03-01T00:00:00Z");
const WEEK_AGO = new Date(NOW.getTime() - 7 * 86_400_000);

/** Two seat-billed schools, the first of which cannot be priced. */
const SUBS = [
  { id: "s1", schoolId: "school-bad", plan: "ENTERPRISE", currency: "GHS", seats: 1, currentPeriodEnd: new Date(NOW.getTime() + 60 * 86_400_000), arrearsAccruedAt: WEEK_AGO },
  { id: "s2", schoolId: "school-ok", plan: "ENTERPRISE", currency: "NGN", seats: 1, currentPeriodEnd: new Date(NOW.getTime() + 60 * 86_400_000), arrearsAccruedAt: WEEK_AGO },
];

function makeService(opts: { seatQueryThrows?: boolean } = {}) {
  const update = jest.fn().mockResolvedValue({});
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const svc = Object.create(BillingDunningService.prototype) as BillingDunningService;
  Object.assign(svc, {
    logger,
    pricing: {
      effective: jest.fn(async (currency: string) => {
        // The real service refuses a currency with no price list rather than
        // quoting a tier at zero.
        if (currency !== "NGN" && currency !== "USD") throw new Error(`No plan pricing for ${currency}`);
        return { STANDARD: { perSeatMonthlyMinor: 52_500 }, PREMIUM: { perSeatMonthlyMinor: 75_000 }, ULTIMATE: { perSeatMonthlyMinor: 97_500 }, ENTERPRISE: { perSeatMonthlyMinor: 125_000 } };
      }),
    },
  });
  const client = {
    schoolSubscription: { update },
    $queryRaw: opts.seatQueryThrows
      ? jest.fn().mockRejectedValue(new Error("connection reset"))
      : jest.fn().mockResolvedValue([
          { schoolId: "school-bad", seats: BigInt(400) },
          { schoolId: "school-ok", seats: BigInt(400) },
        ]),
  };
  const accrue = (svc as unknown as {
    accrueSeatArrears: (c: unknown, s: unknown, n: Date) => Promise<string[]>;
  }).accrueSeatArrears.bind(svc);
  return { accrue, client, update, logger };
}

describe("metering seat growth across the fleet", () => {
  afterEach(() => jest.restoreAllMocks());

  it("KEEPS GOING past a school it cannot price", async () => {
    const { accrue, client, update } = makeService();
    const failed = await accrue(client, SUBS, NOW);
    expect(failed).toEqual(["school-bad"]);
    // The healthy school was metered. Before this, it was not — one unrelated
    // school's currency stopped the platform billing anybody for seat growth.
    const metered = update.mock.calls.map((c) => c[0].where.id);
    expect(metered).toContain("s2");
    expect(metered).not.toContain("s1");
  });

  it("NAMES the school that failed, at error level", async () => {
    // A count says four failed and never which, and the one failing every night
    // is the one worth fixing.
    const { accrue, client, logger } = makeService();
    await accrue(client, SUBS, NOW);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("school-bad"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("GHS"));
  });

  it("does NOT advance the failed school's stamp", async () => {
    // The window is not lost: tomorrow's sweep meters this school from the same
    // starting point and picks up everything it missed.
    const { accrue, client, update } = makeService();
    await accrue(client, SUBS, NOW);
    expect(update.mock.calls.every((c) => c[0].where.id !== "s1")).toBe(true);
  });

  it("reports EVERY school when the fleet-wide seat query itself dies", async () => {
    // That failure genuinely aborts the accrual, so it is reported as what it
    // is — nobody was metered — rather than as a warning nobody reads.
    const { accrue, client } = makeService({ seatQueryThrows: true });
    expect(await accrue(client, SUBS, NOW)).toEqual(["school-bad", "school-ok"]);
  });

  it("meters nothing for a school that never bought seats", async () => {
    // A trial or comped subscription has no billed seat count to grow past, and
    // must not be reported as a failure either.
    const { accrue, client, update } = makeService();
    const failed = await accrue(client, [{ ...SUBS[1], seats: null }], NOW);
    expect(failed).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });
});
