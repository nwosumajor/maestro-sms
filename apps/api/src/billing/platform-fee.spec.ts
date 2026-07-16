import { DEFAULT_PLATFORM_FEE, PLATFORM_FEE_BEARERS, computePlatformFeeMinor } from "@sms/types";

describe("computePlatformFeeMinor", () => {
  const cfg = (over: Partial<typeof DEFAULT_PLATFORM_FEE>) => ({ ...DEFAULT_PLATFORM_FEE, ...over });

  it("is ZERO by default — nobody is charged until the operator opts in", () => {
    expect(computePlatformFeeMinor(1_000_000, DEFAULT_PLATFORM_FEE)).toBe(0);
    expect(DEFAULT_PLATFORM_FEE.bearer).toBe(PLATFORM_FEE_BEARERS.PARENT);
  });

  it("flat + basis-point components add up (100 bp = 1%)", () => {
    // ₦100 flat + 1% of ₦10,000 = ₦100 + ₦100 = ₦200 (in kobo).
    expect(computePlatformFeeMinor(1_000_000, cfg({ flatMinor: 10_000, percentBp: 100 }))).toBe(20_000);
  });

  it("rounds the bp component half-up on odd amounts", () => {
    // 1.5% of 333 kobo = 4.995 → 5.
    expect(computePlatformFeeMinor(333, cfg({ percentBp: 150 }))).toBe(5);
  });

  it("caps the total fee", () => {
    expect(computePlatformFeeMinor(10_000_000, cfg({ percentBp: 100, capMinor: 50_000 }))).toBe(50_000);
  });

  it("never exceeds the amount, never negative, zero on zero", () => {
    expect(computePlatformFeeMinor(500, cfg({ flatMinor: 10_000 }))).toBe(500);
    expect(computePlatformFeeMinor(0, cfg({ flatMinor: 10_000 }))).toBe(0);
    expect(computePlatformFeeMinor(-100, cfg({ flatMinor: 10_000 }))).toBe(0);
    expect(computePlatformFeeMinor(1_000, cfg({ flatMinor: -5, percentBp: -5 }))).toBe(0);
  });
});
