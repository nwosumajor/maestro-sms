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

import { COMPLIANCE_PROFILES, COUNTRIES, breachDeadlineBasis, breachTarget, complianceProfile, countryProfile } from "@sms/types";

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
    // Was >20 before most of Africa was modelled; the count is now the countries
    // outside the catalogue's coverage, and the assertion that matters is not
    // how many there are but that each one SAYS it is unmodelled.
    const un = Object.values(COUNTRIES).filter((c) => c.compliance === "UNSPECIFIED");
    expect(un.length).toBeGreaterThan(0);
    // And every one of them resolves to a profile that says so out loud.
    for (const c of un) expect(complianceProfile(c.compliance).note).toMatch(/does not model/i);
  });
});

// =============================================================================
// The rest of Africa
// =============================================================================
// Naming the law and the regulator tells a school in Kampala or Dakar that it
// HAS obligations and who supervises them — the half that changes behaviour, and
// the half a wrong answer does least damage on. The notification DEADLINE is the
// opposite on both counts, so it is `unknown` for every regime added here rather
// than guessed. These tests exist to keep it that way.

describe("African regimes beyond the first four", () => {
  const AFRICAN_MODELLED = [
    "UG_DPPA", "TZ_PDPA", "RW_DPL", "ET_PDPP", "ZM_DPA", "ZW_CDPA", "BW_DPA", "MW_DPA",
    "EG_PDPL", "MA_0908", "TN_2004", "SN_2008", "CI_2013", "ML_2013", "BJ_CODE",
    "BF_2004", "TG_2019", "NE_2017", "GA_2011", "CD_CODE",
  ];

  it("names a law and a supervising authority for each", () => {
    for (const key of AFRICAN_MODELLED) {
      const p = COMPLIANCE_PROFILES[key];
      expect(p).toBeDefined();
      expect(p.modelled).toBe(true);
      expect(p.authority).toBeTruthy();
      expect(p.label.length).toBeGreaterThan(8);
    }
  });

  it("does NOT invent a notification deadline for any of them", () => {
    // The load-bearing assertion. A school that misses a 48-hour deadline
    // because this table said 72 is worse off than one told to go and check.
    for (const key of AFRICAN_MODELLED) {
      expect(COMPLIANCE_PROFILES[key].breachNotify.kind).toBe("unknown");
      expect(breachTarget(key).statutory).toBe(false);
    }
  });

  it("tells each of them to confirm the window, in the note", () => {
    // The countdown still runs, so the note is the only thing that stops it
    // reading as a legal deadline.
    for (const key of AFRICAN_MODELLED) {
      expect(COMPLIANCE_PROFILES[key].note).toMatch(/confirm|Confirm/);
    }
  });

  it("distinguishes 'the law names no period' from 'we have not established it'", () => {
    // Collapsing these two is the error the three-state model exists to prevent.
    expect(breachDeadlineBasis("POPIA")).toBe("no-fixed-period");
    expect(breachDeadlineBasis("UG_DPPA")).toBe("unknown");
    expect(breachDeadlineBasis("NDPR")).toBe("statutory");
  });

  it("never asserts 'no fixed period' for a country it does not model", () => {
    // UNSPECIFIED must be `unknown`: asserting the statute names no period
    // presumes a statute we have not established exists.
    expect(COMPLIANCE_PROFILES.UNSPECIFIED.breachNotify.kind).toBe("unknown");
    expect(breachDeadlineBasis("NONE")).toBe("unknown");
  });

  it("says what IS required where no officer is, rather than implying nothing is", () => {
    // The older francophone statutes are built on DECLARATION to the authority.
    // `officerRequired: false` there is correct and must not read as "no duty".
    const declarationBased = ["MA_0908", "TN_2004", "SN_2008", "CI_2013", "ML_2013", "BF_2004", "GA_2011"];
    for (const key of declarationBased) {
      const p = COMPLIANCE_PROFILES[key];
      expect(p.officerRequired).toBe(false);
      expect(p.note).toMatch(/declaration|authorisation|register/i);
    }
  });

  it("leaves countries whose statute could not be established UNSPECIFIED", () => {
    // Asserting a law exists is the same class of error as asserting none does.
    for (const code of ["NA", "SL", "LR", "GM", "CM"]) {
      expect(complianceProfile(countryProfile(code).compliance).modelled).toBe(false);
    }
  });

  it("now models most of Africa, and every mapping resolves", () => {
    const african = Object.values(COUNTRIES).filter((c) => c.timezone.startsWith("Africa"));
    const modelled = african.filter((c) => complianceProfile(c.compliance).modelled);
    expect(african.length).toBe(29);
    expect(modelled.length).toBe(24);
    for (const c of african) expect(COMPLIANCE_PROFILES[c.compliance]).toBeDefined();
  });
});
