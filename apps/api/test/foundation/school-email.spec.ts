// =============================================================================
// School-scoped login identifiers — the pure generator
// =============================================================================
// These identifiers are how the platform stops a GLOBAL email collision from
// blocking a legitimate signup: the school's own unique slug is the subdomain,
// so the same name at two schools produces two different addresses.
//
// The most important test in this file is the LAST group: a generated address is
// never a delivery target. If that regresses, password-reset links and payment
// receipts get sent to a mailbox that does not exist — silently.
// =============================================================================
import {
  generateLoginEmail,
  loginLocalPart,
  loginEmailCandidates,
  schoolLoginDomain,
  isGeneratedLoginEmail,
  deliverableEmail,
  LOGIN_EMAIL_DOMAIN,
} from "@sms/types";

describe("loginLocalPart", () => {
  it("builds first.last", () => {
    expect(loginLocalPart("Adams James")).toBe("adams.james");
  });

  it("uses the SURNAME when there are middle names — that is what people are known by", () => {
    expect(loginLocalPart("Adams Chidi James")).toBe("adams.james");
    expect(loginLocalPart("Ngozi Amaka Chioma Obi")).toBe("ngozi.obi");
  });

  it("handles a single name", () => {
    expect(loginLocalPart("Madonna")).toBe("madonna");
  });

  it("strips accents, apostrophes and hyphens — real Nigerian and international rolls contain all three", () => {
    expect(loginLocalPart("Ọláwálé Obi-Eze")).toBe("olawale.obieze");
    expect(loginLocalPart("O'Brien Ngozi")).toBe("obrien.ngozi");
    expect(loginLocalPart("N'Diaye Aïcha")).toBe("ndiaye.aicha");
  });

  it("collapses whitespace and case", () => {
    expect(loginLocalPart("  ADAMS   james  ")).toBe("adams.james");
  });

  it("returns empty when nothing usable survives, rather than throwing", () => {
    expect(loginLocalPart("!!! ???")).toBe("");
    expect(loginLocalPart("")).toBe("");
  });
});

describe("generateLoginEmail", () => {
  it("puts the school slug in the subdomain", () => {
    expect(generateLoginEmail("Adams James", "standrews")).toBe(
      `adams.james@standrews.${LOGIN_EMAIL_DOMAIN}`,
    );
  });

  it("THE POINT: the same name at two schools does NOT collide", () => {
    const a = generateLoginEmail("Adams James", "standrews");
    const b = generateLoginEmail("Adams James", "maestro");
    expect(a).not.toBe(b);
  });

  it("suffixes a within-school clash, starting at 2 (a human counts 1,2,3 not 0,1,2)", () => {
    expect(generateLoginEmail("Adams James", "standrews", 0)).toBe(
      `adams.james@standrews.${LOGIN_EMAIL_DOMAIN}`,
    );
    expect(generateLoginEmail("Adams James", "standrews", 1)).toBe(
      `adams.james2@standrews.${LOGIN_EMAIL_DOMAIN}`,
    );
    expect(generateLoginEmail("Adams James", "standrews", 2)).toBe(
      `adams.james3@standrews.${LOGIN_EMAIL_DOMAIN}`,
    );
  });

  it("falls back to a usable local part when the name yields nothing", () => {
    expect(generateLoginEmail("!!!", "standrews")).toBe(`user@standrews.${LOGIN_EMAIL_DOMAIN}`);
  });

  it("normalises a slug that contains punctuation", () => {
    expect(schoolLoginDomain("st-andrews")).toBe(`standrews.${LOGIN_EMAIL_DOMAIN}`);
  });

  it("always produces a syntactically valid address", () => {
    const re = /^[a-z0-9.]+@[a-z0-9.]+\.[a-z]{2,}$/;
    for (const name of ["Adams James", "Madonna", "Ọláwálé Obi-Eze", "!!!", "N'Diaye Aïcha"]) {
      expect(generateLoginEmail(name, "st-andrews")).toMatch(re);
    }
  });
});

describe("loginEmailCandidates", () => {
  it("returns distinct candidates in preference order", () => {
    const c = loginEmailCandidates("Adams James", "standrews", 4);
    expect(c).toHaveLength(4);
    expect(new Set(c).size).toBe(4);
    expect(c[0]).toBe(`adams.james@standrews.${LOGIN_EMAIL_DOMAIN}`);
    expect(c[1]).toBe(`adams.james2@standrews.${LOGIN_EMAIL_DOMAIN}`);
  });
});

// -----------------------------------------------------------------------------
// The safety property. A generated address has NO mailbox behind it.
// -----------------------------------------------------------------------------
describe("deliverability — a generated identifier is NEVER a delivery target", () => {
  const generated = `adams.james@standrews.${LOGIN_EMAIL_DOMAIN}`;

  it("recognises its own generated addresses", () => {
    expect(isGeneratedLoginEmail(generated)).toBe(true);
    expect(isGeneratedLoginEmail("ADAMS.JAMES@STANDREWS.MAJORMAESTRO.COM")).toBe(true);
    expect(isGeneratedLoginEmail("parent@gmail.com")).toBe(false);
    // A lookalike that is NOT our subdomain must not be mistaken for one.
    expect(isGeneratedLoginEmail("someone@notmajormaestro.com")).toBe(false);
  });

  it("returns NULL rather than falling back to the generated address", () => {
    // The whole point: no contact address means do not send, NOT send to a
    // mailbox that does not exist.
    expect(deliverableEmail({ email: generated })).toBeNull();
    expect(deliverableEmail({ email: generated, contactEmail: null })).toBeNull();
    expect(deliverableEmail({ email: generated, contactEmail: "   " })).toBeNull();
  });

  it("prefers contactEmail when present", () => {
    expect(deliverableEmail({ email: generated, contactEmail: "mum@gmail.com" })).toBe("mum@gmail.com");
  });

  it("keeps working for legacy users whose login IS their real address", () => {
    expect(deliverableEmail({ email: "parent@gmail.com" })).toBe("parent@gmail.com");
    expect(deliverableEmail({ email: "parent@gmail.com", contactEmail: "other@gmail.com" })).toBe(
      "other@gmail.com",
    );
  });
});
