// =============================================================================
// The cap that bounds what a parent pays was a naira figure, in every currency
// =============================================================================
// `platform_fee_config` was a SINGLETON keyed id='fees', carrying `flatMinor`
// and `capMinor` in minor units with NO currency. The take-rate rides the
// Paystack split, and Paystack settles NGN, GHS, ZAR, KES and USD — so the same
// kobo figures were applied to all of them.
//
// Measured against the live row (150bp capped at 200,000 = NGN 2,000):
//
//   NGN 150,000 -> parent pays NGN 2,000   cap binds, as intended
//   GHS   5,000 -> parent pays GHS    75   "cap" is GHS 2,000 — never binds
//   KES  75,000 -> parent pays KES 1,125   "cap" is KES 2,000 — never binds
//   ZAR  15,000 -> parent pays ZAR   225   "cap" is ZAR 2,000 — never binds
//
// The cap is the ONLY thing bounding a convenience fee the PARENT bears.
// =============================================================================

import { DEFAULT_PLATFORM_FEE, computePlatformFeeMinor, type PlatformFeeConfig } from "@sms/types";
import { PlatformFeeService } from "../../src/billing/platform-fee.service";

/** The live configuration, as it stands in the database today. */
const NAIRA_CONFIG: PlatformFeeConfig = {
  flatMinor: 0,
  percentBp: 150,
  capMinor: 200_000,
  bearer: "PARENT",
};

describe("a take-rate cap is not a naira cap", () => {
  it("charges NOTHING in a currency the operator has not priced", async () => {
    // THE DIRECTION MATTERS. This repo's rule: an unset CONTROL tightens, an
    // unset CHARGE goes to ZERO — "because a charge that guesses bills a
    // family". A take-rate is a charge, and it is borne by the PARENT, so a
    // currency with no row must cost nothing rather than inherit kobo figures.
    const svc = serviceWithRows([{ id: "fees", currency: "NGN", ...NAIRA_CONFIG }]);

    const ngn = await svc.effective("NGN");
    expect(ngn).toMatchObject({ percentBp: 150, capMinor: 200_000 });

    for (const unpriced of ["GHS", "KES", "ZAR", "USD"]) {
      const cfg = await svc.effective(unpriced);
      expect(cfg).toEqual(DEFAULT_PLATFORM_FEE);
      expect(computePlatformFeeMinor(5_000_00, cfg)).toBe(0);
    }
  });

  it("uses the row for the currency being charged, not the first row it finds", async () => {
    const svc = serviceWithRows([
      { id: "fees", currency: "NGN", ...NAIRA_CONFIG },
      { id: "fees", currency: "GHS", flatMinor: 0, percentBp: 150, capMinor: 2_000, bearer: "PARENT" },
    ]);
    // GHS 5,000 at 150bp is GHS 75, under a GHS 20 cap -> capped at GHS 20.
    const ghs = await svc.effective("GHS");
    expect(computePlatformFeeMinor(500_000, ghs)).toBe(2_000);
    // The same invoice under the NAIRA cap was charged the full 150bp, because
    // GHS 2,000 is ~100x the intended ceiling. That is the bug.
    expect(computePlatformFeeMinor(500_000, NAIRA_CONFIG)).toBe(7_500);
  });

  it("is case-insensitive about the currency it is asked for", async () => {
    const svc = serviceWithRows([{ id: "fees", currency: "NGN", ...NAIRA_CONFIG }]);
    expect(await svc.effective("ngn")).toMatchObject({ percentBp: 150 });
  });

  it("echoes back the currency it just wrote, not the default one", async () => {
    // Measured live before the fix: PUT {currency:"GHS", capMinor:2000} answered
    // capMinor 200000 — the naira row — which reads to an operator as a save
    // that did not take. The GET beside it was already correct.
    const rows: Row[] = [{ id: "fees", currency: "NGN", ...NAIRA_CONFIG }];
    const svc = serviceWithRows(rows);
    const written = { flatMinor: 0, percentBp: 150, capMinor: 2_000, bearer: "PARENT" as const };
    const client = { platformFeeConfig: { upsert: async () => { rows.push({ id: "fees", currency: "GHS", ...written }); } } };
    Object.assign(svc as unknown as { privileged: unknown }, { privileged: { client } });
    Object.assign(svc as unknown as { db: unknown }, { db: { runAsTenant: async () => undefined } });
    Object.assign(svc as unknown as { audit: unknown }, { audit: { record: async () => undefined } });

    const back = await svc.update({ userId: "u", schoolId: "s" } as never, written, "GHS");
    expect(back.capMinor).toBe(2_000);
  });

  it("leaves a naira school charged exactly what it was charged before", async () => {
    const svc = serviceWithRows([{ id: "fees", currency: "NGN", ...NAIRA_CONFIG }]);
    const cfg = await svc.effective();
    // NGN 150,000 -> 150bp is NGN 2,250, capped to NGN 2,000.
    expect(computePlatformFeeMinor(15_000_000, cfg)).toBe(200_000);
  });
});

type Row = { id: string; currency: string } & PlatformFeeConfig;

function serviceWithRows(rows: Row[]): PlatformFeeService {
  jest
    .spyOn(
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- reason: the
      // service reads the global prisma singleton directly, so the stub goes there.
      require("@sms/db").prisma.platformFeeConfig,
      "findFirst",
    )
    .mockImplementation((async (args: { where: { id: string; currency: string } }) =>
      rows.find((r) => r.id === args.where.id && r.currency === args.where.currency) ?? null) as never);
  return new PlatformFeeService({} as never, {} as never, {} as never);
}
