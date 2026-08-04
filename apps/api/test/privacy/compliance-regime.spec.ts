// =============================================================================
// Privacy regimes — the platform must not state obligations it cannot support
// =============================================================================
// The compliance posture is the one screen whose entire job is to be accurate
// about legal duties, and it made two affirmative claims it could not support:
//
//   • 34 of 37 countries were "NONE", which reads as "no privacy law applies
//     here". Kenya has the DPA 2019, South Africa POPIA, Ghana the DPA 2012.
//   • `dpoRequired` was true only for GDPR and NDPR, so those schools were told
//     explicitly that no officer was required. Saying nothing would have been
//     safer than saying that.
//
// The rule these tests defend: an unmodelled country must read as "we do not
// know your obligations", never as "you have none".

import { COMPLIANCE_PROFILES, COUNTRIES, breachTarget, complianceProfile, countryProfile } from "@sms/types";

describe("complianceProfile", () => {
  it("resolves the legacy NONE value to UNSPECIFIED, not to nothing", () => {
    // Existing rows hold "NONE". The value stays; the claim it makes changes —
    // that is the whole point of doing this without a data migration.
    expect(complianceProfile("NONE").key).toBe("UNSPECIFIED");
    expect(complianceProfile(null).key).toBe("UNSPECIFIED");
    expect(complianceProfile(undefined).key).toBe("UNSPECIFIED");
  });

  it("marks an unknown regime as NOT modelled rather than inventing one", () => {
    expect(complianceProfile("SOMETHING_NEW").modelled).toBe(false);
  });

  it("never claims an officer is unnecessary for a modelled regime", () => {
    for (const key of ["GDPR", "NDPR", "KE_DPA", "POPIA", "GH_DPA"]) {
      expect(COMPLIANCE_PROFILES[key].officerRequired).toBe(true);
    }
  });

  it("does not assert an officer requirement for a country it cannot speak to", () => {
    // The honest position: we do not know, so we do not demand. The screen says
    // the law is not modelled instead.
    expect(COMPLIANCE_PROFILES.UNSPECIFIED.officerRequired).toBe(false);
    expect(COMPLIANCE_PROFILES.UNSPECIFIED.modelled).toBe(false);
  });

  it("names the officer by the title the regime actually uses", () => {
    // POPIA's is an Information Officer. Asking a South African school for a
    // "DPO" asks for the wrong thing by the wrong name.
    expect(COMPLIANCE_PROFILES.POPIA.officerTitle).toBe("Information Officer");
    expect(COMPLIANCE_PROFILES.GDPR.officerTitle).toBe("Data Protection Officer");
  });

  it("says WHO a breach is reported to, for every modelled regime", () => {
    for (const key of ["GDPR", "NDPR", "KE_DPA", "POPIA", "GH_DPA"]) {
      expect(COMPLIANCE_PROFILES[key].authority).toBeTruthy();
    }
    expect(COMPLIANCE_PROFILES.UNSPECIFIED.authority).toBeNull();
  });
});

describe("breachTarget", () => {
  it("is 72 STATUTORY hours where the statute says 72", () => {
    for (const key of ["GDPR", "NDPR", "KE_DPA"]) {
      expect(breachTarget(key)).toEqual({ hours: 72, statutory: true });
    }
  });

  it("does NOT present 72 hours as law under POPIA, which sets no fixed period", () => {
    // The distinction this whole change exists for: the same countdown, worded
    // as practice rather than as statute.
    const t = breachTarget("POPIA");
    expect(t.statutory).toBe(false);
    expect(t.hours).toBe(72);
  });

  it("gives an unmodelled country a working clock, marked non-statutory", () => {
    // Dropping the register for a country we do not model would be worse than a
    // wrong label — a breach register is useful under any law.
    const t = breachTarget("NONE");
    expect(t.hours).toBe(72);
    expect(t.statutory).toBe(false);
  });

  it("never returns a null deadline, whatever the regime", () => {
    for (const key of [...Object.keys(COMPLIANCE_PROFILES), "NONE", null, "junk"]) {
      const t = breachTarget(key as string | null);
      expect(typeof t.hours).toBe("number");
      expect(t.hours).toBeGreaterThan(0);
    }
  });
});

describe("the country catalogue", () => {
  it("maps the African countries whose law IS modelled", () => {
    expect(countryProfile("KE").compliance).toBe("KE_DPA");
    expect(countryProfile("ZA").compliance).toBe("POPIA");
    expect(countryProfile("GH").compliance).toBe("GH_DPA");
    expect(countryProfile("NG").compliance).toBe("NDPR");
  });

  it("no longer labels any country 'NONE'", () => {
    // The word itself was the defect: it asserted an absence of law.
    const nones = Object.values(COUNTRIES).filter((c) => c.compliance === "NONE");
    expect(nones.map((c) => c.code)).toEqual([]);
  });

  it("gives every country a regime the profile table actually knows", () => {
    for (const c of Object.values(COUNTRIES)) {
      expect(COMPLIANCE_PROFILES[c.compliance]).toBeDefined();
    }
  });

  it("keeps GDPR for the UK and Ireland", () => {
    expect(countryProfile("GB").compliance).toBe("GDPR");
    expect(countryProfile("IE").compliance).toBe("GDPR");
  });

  it("marks the rest UNSPECIFIED — honest, not silent", () => {
    const un = Object.values(COUNTRIES).filter((c) => c.compliance === "UNSPECIFIED");
    expect(un.length).toBeGreaterThan(20);
    // And every one of them resolves to a profile that says so out loud.
    for (const c of un) expect(complianceProfile(c.compliance).note).toMatch(/does not model/i);
  });
});
