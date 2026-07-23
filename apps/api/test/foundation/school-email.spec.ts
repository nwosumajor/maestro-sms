// =============================================================================
// School-scoped login identifiers — the pure generators
// =============================================================================
// Login identifiers are firstname.lastname@<slug>.com, where <slug> is the
// school's own UNIQUE slug. Two properties matter and both are tested here:
//
//   1. The same name at two schools does NOT collide (different domain).
//   2. A generated identifier is NEVER a delivery target. Its domain is not
//      ours, so sending there would post student data and password-reset links
//      to a stranger's mail server — silently. That is the last group, and it is
//      the most important test in this file.
// =============================================================================
import {
  baseSchoolSlug,
  schoolSlugCandidates,
  schoolLoginDomain,
  loginLocalPart,
  generateLoginEmail,
  deliverableEmail,
  MAX_SCHOOL_SLUG_LENGTH,
} from "@sms/types";

describe("baseSchoolSlug — short, readable, identity-preserving", () => {
  it("drops words that carry no identity", () => {
    expect(baseSchoolSlug("Maestro High School")).toBe("maestro");
    expect(baseSchoolSlug("St. Andrews Academy")).toBe("standrews");
    expect(baseSchoolSlug("The International College of Lagos")).toBe("lagos");
  });

  it("never exceeds the cap — it has to work as a domain label", () => {
    for (const name of [
      "Elshaddi British High School",
      "Our Lady of Perpetual Succour Comprehensive Secondary School",
      "Federal Government Girls College Sagamu",
    ]) {
      expect(baseSchoolSlug(name).length).toBeLessThanOrEqual(MAX_SCHOOL_SLUG_LENGTH);
    }
  });

  it("survives a name made entirely of stopwords rather than returning empty", () => {
    expect(baseSchoolSlug("The School")).toBe("theschool");
    expect(baseSchoolSlug("!!!")).toBe("school");
  });

  it("folds accents and punctuation", () => {
    expect(baseSchoolSlug("Ọláwálé Academy")).toBe("olawale");
    expect(baseSchoolSlug("St. Mary's")).toBe("stmarys");
  });
});

describe("schoolSlugCandidates — uniqueness across schools", () => {
  it("offers distinct alternatives when the base is taken", () => {
    const c = schoolSlugCandidates("Maestro High School", 4);
    expect(c[0]).toBe("maestro");
    expect(c[1]).toBe("maestro2");
    expect(new Set(c).size).toBe(4);
  });

  it("keeps EVERY candidate within the cap — the suffix trims the base, never overflows", () => {
    for (const c of schoolSlugCandidates("Our Lady of Perpetual Succour College", 30)) {
      expect(c.length).toBeLessThanOrEqual(MAX_SCHOOL_SLUG_LENGTH);
    }
  });
});

describe("loginLocalPart", () => {
  it("builds firstname.lastname", () => {
    expect(loginLocalPart("Adams James")).toBe("adams.james");
  });

  it("KEEPS middle names — the collision message tells admins to add one, so it must help", () => {
    expect(loginLocalPart("Adams Chidi James")).toBe("adams.chidi.james");
    // The whole point: it must NOT collide with the plain two-part name.
    expect(loginLocalPart("Adams Chidi James")).not.toBe(loginLocalPart("Adams James"));
  });

  it("handles a single name", () => {
    expect(loginLocalPart("Madonna")).toBe("madonna");
  });

  it("strips accents, apostrophes and hyphens — real school rolls contain all three", () => {
    expect(loginLocalPart("Ọláwálé Obi-Eze")).toBe("olawale.obieze");
    expect(loginLocalPart("O'Brien Ngozi")).toBe("obrien.ngozi");
  });

  it("returns empty rather than throwing when nothing usable survives", () => {
    expect(loginLocalPart("!!!")).toBe("");
  });
});

describe("generateLoginEmail", () => {
  it("is firstname.lastname@<slug>.com", () => {
    expect(generateLoginEmail("Adams James", "maestro")).toBe("adams.james@maestro.com");
    expect(schoolLoginDomain("standrews")).toBe("standrews.com");
  });

  it("THE POINT: the same name at two schools does NOT collide", () => {
    expect(generateLoginEmail("Adams James", "maestro")).not.toBe(
      generateLoginEmail("Adams James", "standrews"),
    );
  });

  it("is deterministic — the same (name, slug, suffix) always gives the same address", () => {
    expect(generateLoginEmail("Adams James", "maestro")).toBe(
      generateLoginEmail("Adams James", "maestro"),
    );
  });

  it("numbers a suffix from 2 (a human counts 2, 3 — not 0, 1)", () => {
    expect(generateLoginEmail("Adams James", "maestro", 0)).toBe("adams.james@maestro.com");
    expect(generateLoginEmail("Adams James", "maestro", 1)).toBe("adams.james2@maestro.com");
    expect(generateLoginEmail("Adams James", "maestro", 2)).toBe("adams.james3@maestro.com");
  });

  it("always produces a syntactically valid address", () => {
    const re = /^[a-z0-9.]+@[a-z0-9]+\.com$/;
    for (const n of ["Adams James", "Madonna", "Ọláwálé Obi-Eze", "!!!", "O'Brien Ngozi"]) {
      expect(generateLoginEmail(n, "maestro")).toMatch(re);
    }
  });
});

// -----------------------------------------------------------------------------
// The safety property.
// -----------------------------------------------------------------------------
describe("deliverability — a generated identifier is NEVER a delivery target", () => {
  it("returns NULL for a generated identifier with no contact address", () => {
    // Not a fallback: maestro.com is not ours. Returning the login identifier
    // here would post student data to whoever owns that domain.
    expect(
      deliverableEmail({ email: "adams.james@maestro.com", loginEmailGenerated: true }),
    ).toBeNull();
  });

  it("prefers contactEmail", () => {
    expect(
      deliverableEmail({
        email: "adams.james@maestro.com",
        loginEmailGenerated: true,
        contactEmail: "adams@gmail.com",
      }),
    ).toBe("adams@gmail.com");
  });

  it("trusts email ONLY for legacy accounts, whose address really is their own", () => {
    expect(deliverableEmail({ email: "parent@gmail.com", loginEmailGenerated: false })).toBe(
      "parent@gmail.com",
    );
    // Flag absent (older row / partial select) behaves as legacy — matches the
    // column default, so the migration cannot silently stop mail for anyone.
    expect(deliverableEmail({ email: "parent@gmail.com" })).toBe("parent@gmail.com");
  });

  it("is null-safe on partial rows rather than throwing inside the delivery path", () => {
    expect(deliverableEmail({})).toBeNull();
    expect(deliverableEmail({ email: null, contactEmail: null })).toBeNull();
    expect(deliverableEmail({ email: "  ", contactEmail: "  " })).toBeNull();
  });

  it("REGRESSION: a generated identifier must not leak even if contactEmail is blank", () => {
    expect(
      deliverableEmail({
        email: "adams.james@maestro.com",
        loginEmailGenerated: true,
        contactEmail: "   ",
      }),
    ).toBeNull();
  });
});
