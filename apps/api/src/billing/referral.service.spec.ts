import { genReferralCode } from "./referral.service";

describe("genReferralCode", () => {
  it("prefixes with the normalised school name and adds a 4-char suffix", () => {
    const code = genReferralCode("Greenfield High School");
    expect(code).toMatch(/^GREENFIELD-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it("caps the prefix at 10 chars and strips non-alphanumerics", () => {
    const code = genReferralCode("St. Andrew's — Comprehensive Academy!");
    const [prefix, suffix] = code.split("-");
    expect(prefix!.length).toBeLessThanOrEqual(10);
    expect(prefix).toMatch(/^[A-Z0-9]+$/);
    expect(suffix).toHaveLength(4);
  });

  it("falls back to SCHOOL for a name with no usable characters", () => {
    expect(genReferralCode("—— !!! ——")).toMatch(/^SCHOOL-/);
  });

  it("suffix never uses 0/O/1/I/L lookalikes", () => {
    for (let i = 0; i < 50; i++) {
      const suffix = genReferralCode("Test").split("-")[1]!;
      expect(suffix).not.toMatch(/[0OIL1]/);
    }
  });
});
