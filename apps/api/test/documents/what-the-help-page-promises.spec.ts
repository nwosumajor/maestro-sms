/**
 * Two claims in the guide everybody reads, both wrong about what to do next.
 *
 * 1. "three failed sign-ins lock the account until an administrator reactivates
 *    it". NO administrator in a school can. The only unlock route in the product
 *    is `POST /operator/tenants/:schoolId/users/:userId/unlock`, gated on
 *    `platform.user.unlock` — held by super_admin alone — and there is no
 *    school-side equivalent. A locked-out teacher asked their own office, which
 *    had no button to press, and this sentence is what sent them there.
 *
 * 2. "payment and security notices are always sent", one sentence after "switch
 *    email, SMS or WhatsApp on or off". `allowedChannels` lets an ESSENTIAL type
 *    ignore a category MUTE and then filters by the channel toggles all the
 *    same, so a guardian who turns email off gets no fee reminders by email.
 *    Read in place, "always sent" meant the opposite of what the code does.
 *
 * Both are checked against the CODE here, not against a remembered rule, so the
 * guide fails the build if either behaviour changes under it.
 */
import { readFileSync } from "fs";
import { stripComments } from "../support/strip-comments";
import { join } from "path";
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  PLANS,
  planCurrencies,
  allowedChannels,
  BULK_IMPORT_MAX_ROWS,
  CYCLE_DISCOUNT_PERCENT,
  CYCLE_MONTHS,
  REFERRAL_REWARD_MONTHS,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_TRIAL_DAYS,
} from "@sms/types";

const HELP = stripComments(readFileSync(join(__dirname, "../../../../apps/web/app/(app)/help/page.tsx"), "utf8"));
const help = HELP;
/**
 * The manual makes the SAME promises to the same people — a school owner reads
 * it before anybody signs in — so it is held to the same rules. It was not, and
 * it drifted: `/help` was corrected for the lockout wording and the manual kept
 * "only an administrator can reactivate it" for as long as this gate existed.
 * Two documents describing one product need one gate, or the careful half is
 * fixed and the other is left.
 */
const MANUAL = readFileSync(join(__dirname, "../../../../docs/ONBOARDING-MANUAL.html"), "utf8");
const API = join(__dirname, "../../src");

describe("this gate read the documents at all", () => {
  // Required by `a-gate-must-not-pass-by-finding-nothing`, and it is a real
  // guard rather than box-ticking: nearly every assertion below is a
  // `not.toMatch`, and an EMPTY string satisfies all of them. If either document
  // ever failed to read, this file would go green while checking nothing.
  it("both documents are present and substantial", () => {
    expect(help.length).toBeGreaterThan(20000);
    expect(MANUAL.length).toBeGreaterThan(50000);
  });

  it("and the API surface it checks its premises against is present", () => {
    const routes = require("../support/api-routes").apiRoutes() as Array<{ key: string }>;
    expect(routes.length).toBeGreaterThan(500);
  });
});

describe("what the help page promises", () => {
  it("no school-side unlock route exists, which is why the wording changed", () => {
    // The premise. If one is ever added, this fails and the guide can say so.
    const controllers = require("../support/api-routes").apiRoutes() as Array<{ key: string; file: string }>;
    const unlocks = controllers.filter((r) => /unlock/i.test(r.key));
    expect(unlocks.map((r) => r.key)).toEqual([
      "POST /operator/tenants/:schoolId/users/:userId/unlock",
    ]);
  });

  it("does not tell a user their administrator can reactivate a locked account", () => {
    expect(help).not.toMatch(/until an administrator reactivates it/);
  });

  it("says who actually can, and what to do", () => {
    expect(help).toMatch(/only the platform operator can/i);
    expect(help).toMatch(/contact support/i);
  });

  it("an essential type really does still obey a channel switch", () => {
    // The premise of the second correction, taken from the pure rule rather
    // than from memory.
    const essential = ESSENTIAL_NOTIFICATION_TYPES[0];
    const off = allowedChannels(
      { emailEnabled: false, smsEnabled: true, whatsappEnabled: true, mutedTypes: [] } as never,
      essential,
      ["EMAIL", "IN_APP"],
    );
    expect(off).not.toContain("EMAIL");
  });

  it("and really does ignore a category mute", () => {
    const essential = ESSENTIAL_NOTIFICATION_TYPES[0];
    const muted = allowedChannels(
      { emailEnabled: true, smsEnabled: true, whatsappEnabled: true, mutedTypes: [essential] } as never,
      essential,
      ["EMAIL"],
    );
    expect(muted).toContain("EMAIL");
  });

  it("no longer claims those notices are sent whatever you switch off", () => {
    expect(help).not.toMatch(/payment and security notices are always sent/);
    expect(help).toMatch(/switching a CHANNEL off silences everything on it/i);
  });

  // ---- the same rules, asked of the manual ----

  it("the manual does not say a school administrator can reactivate a locked account", () => {
    expect(MANUAL).not.toMatch(/only an administrator can reactivate/i);
    expect(MANUAL).not.toMatch(/an administrator can reactivate it/i);
  });

  it("the manual says the lock is permanent and who to ask", () => {
    expect(MANUAL).toMatch(/permanent until we lift it/i);
    expect(MANUAL).toMatch(/#contact/);
  });

  it("neither document claims a junior administrator takes the register", () => {
    // REGISTER_COVER_ROLES is school_admin only — taking a register records who
    // physically looked at the room. Measured: a junior_admin is 403 on it.
    // COMMENTS STRIPPED, and bound to the DECLARATION. This read the raw source
    // and matched `REGISTER_COVER_ROLES[^=]*=` — which, the moment the name was
    // mentioned in a comment above a DIFFERENT constant, ran on to that
    // constant's array and asserted against the wrong set. The file already
    // strips comments for the help page four lines up; this line did not.
    const cover = stripComments(readFileSync(join(API, "attendance/attendance.service.ts"), "utf8"));
    const declared = cover.match(/const REGISTER_COVER_ROLES\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(declared).not.toBeNull();
    expect(declared?.[1]).not.toMatch(/junior_admin/);

    expect(MANUAL).not.toMatch(/junior administrator can maintain records, take and correct attendance/i);
    // /help's junior-admin guide must not promise attendance among the records
    // it keeps current. The word appears elsewhere on the page legitimately, so
    // this asks about the claim rather than the word.
    expect(help).not.toMatch(/guardians, attendance, timetable and documents are yours/i);
  });

  it("neither document says the student import matches on email", () => {
    // Pupils get an identifier generated from their name; two pupils sharing a
    // name both import. "Idempotent on email" told a school a re-upload would
    // update rather than duplicate, which has not been true for some time.
    for (const [name, text] of [["/help", help], ["the manual", MANUAL]] as const) {
      expect({ [name]: /idempotent on email|matches on email address/i.test(text) }).toEqual({ [name]: false });
    }
  });

  it("both documents state the bulk-import row cap the API actually enforces", () => {
    const { BULK_IMPORT_MAX_ROWS } = require("@sms/types");
    expect(typeof BULK_IMPORT_MAX_ROWS).toBe("number");
    // A school meets this on day one with a roll of 900. A cap the documents do
    // not mention is met as a refusal in the middle of onboarding.
    for (const [name, text] of [["/help", help], ["the manual", MANUAL]] as const) {
      expect({ [name]: text.includes(String(BULK_IMPORT_MAX_ROWS)) }).toEqual({ [name]: true });
    }
  });
});

describe("every number the guide quotes is the number the code uses", () => {
  // A figure typed into prose is a claim nobody rechecks. These are the ones a
  // reader ACTS on — how long a trial runs, how long grace lasts, what a
  // commitment discount is worth, how big an upload may be — and each was
  // verified by hand once. Verified by hand is verified once; this asks the
  // constants, so a change to any of them fails the build beside the sentence
  // that would have gone quietly wrong.
  const claims: Array<[string, string, string]> = [
    ["the free trial", `${SUBSCRIPTION_TRIAL_DAYS} days`, "SUBSCRIPTION_TRIAL_DAYS"],
    ["the grace period after a lapse", `${SUBSCRIPTION_GRACE_DAYS} days`, "SUBSCRIPTION_GRACE_DAYS"],
    ["the bulk-import row cap", `${BULK_IMPORT_MAX_ROWS} rows`, "BULK_IMPORT_MAX_ROWS"],
    ["a term's length in months", `${CYCLE_MONTHS.TERM} months`, "CYCLE_MONTHS.TERM"],
    ["a year's billed months", `${CYCLE_MONTHS.YEAR} months`, "CYCLE_MONTHS.YEAR"],
    ["the per-term discount", `${CYCLE_DISCOUNT_PERCENT.TERM}% off`, "CYCLE_DISCOUNT_PERCENT.TERM"],
    ["the per-year discount", `${CYCLE_DISCOUNT_PERCENT.YEAR}% off`, "CYCLE_DISCOUNT_PERCENT.YEAR"],
  ];

  it.each(claims)("states %s as the code does (%s, from %s)", (_what, phrase) => {
    // ANCHORED, not `toContain`. "5% off" is a substring of "15% off", so a
    // plain contains-check passed while the per-term discount had been changed
    // to 8% — the match-by-accident class this repo has its own gate for,
    // committed here by me and caught only by mutating the number.
    expect(help).toMatch(new RegExp(`(?<![\\d.])${phrase.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`));
  });

  it("describes the referral reward as the term length the code grants", () => {
    // REFERRAL_REWARD_MONTHS is CYCLE_MONTHS.TERM, so "one free term" and the
    // month count must agree — and the guide says both.
    expect(REFERRAL_REWARD_MONTHS).toBe(CYCLE_MONTHS.TERM);
    expect(help).toContain(`${REFERRAL_REWARD_MONTHS} months`);
  });

  it("does not quote a stale figure for any of them", () => {
    // The other direction: a number that USED to be right must not survive
    // beside the corrected one. Anything that looks like one of these claims
    // and disagrees with the constant is a failure.
    const wrong: string[] = [];
    const check = (re: RegExp, actual: number, label: string) => {
      for (const m of help.matchAll(re)) {
        if (Number(m[1]) !== actual) wrong.push(`${label}: guide says ${m[1]}, code says ${actual}`);
      }
    };
    check(/(\d+) rows at a time/g, BULK_IMPORT_MAX_ROWS, "bulk import");
    check(/per-term \((\d+) months/g, CYCLE_MONTHS.TERM, "term months");
    check(/per-year \((\d+) months/g, CYCLE_MONTHS.YEAR, "year months");
    expect(wrong).toEqual([]);
  });
});

describe("the alumni register is explained at all", () => {
  // It was in NEITHER document: a shipped module, `alumni.manage` held by
  // principal / school_admin / teacher, a page and a broadcast that emails
  // former pupils — and no guidance anywhere. The module coverage of these two
  // documents was measured against MODULES and this was the only hole.
  it("both documents describe it", () => {
    expect(help).toMatch(/Alumni/i);
    expect(MANUAL).toMatch(/alumni register/i);
  });

  it("both say the register's own email is the audience, not an app inbox", () => {
    // The one thing that most needs saying, and the thing the service went to
    // some trouble to get right: an alumnus has LEFT, cannot sign in, and a
    // notification would land in an inbox nobody can open.
    expect(help).toMatch(/email address IS the audience|sent to the addresses on these records/i);
    expect(MANUAL).toMatch(/to those addresses directly/i);
  });

  it("both tell the reader to read the unreachable count", () => {
    expect(help).toMatch(/unreachable/i);
    expect(MANUAL).toMatch(/could not be reached/i);
  });
});

describe("the manual describes buying a module as the product actually works", () => {
  // It said "ask support to enable it individually" — for something a school
  // administrator can do in two clicks. The add-on shop, its checkout and its
  // CANCEL have all shipped; telling an owner to email support for a self-serve
  // purchase loses the sale and is simply untrue.
  const billing = stripComments(readFileSync(join(API, "billing/billing.controller.ts"), "utf8"));

  it("the self-serve add-on routes really exist", () => {
    // The premise. If the shop is ever withdrawn, this fails and the manual can
    // go back to naming support.
    expect(billing).toMatch(/@Get\("addons"\)/);
    expect(billing).toMatch(/@Post\("addons\/:module\/init"\)/);
    expect(billing).toMatch(/@Post\("addons\/:module\/cancel"\)/);
  });

  it("no longer tells the reader to email support for one", () => {
    // TAGS STRIPPED FIRST. The sentence is "ask <a href=…>support</a> to enable
    // it individually", so a character class that cannot cross a `<` matched
    // nothing and this passed while the claim was back — caught by mutating the
    // manual, not by reading the regex.
    const prose = MANUAL.replace(/<[^>]+>/g, "");
    expect(prose).not.toMatch(/ask\s+support\s+to enable it individually/i);
  });

  it("says they can buy it, and that they can cancel it themselves", () => {
    expect(MANUAL).toMatch(/buy it yourself/i);
    expect(MANUAL).toMatch(/cancel it yourself/i);
  });

  it("states the prorating rule, which is what makes the price look odd", () => {
    // An owner who buys three weeks before renewal is charged for three weeks
    // and would otherwise read the small figure as a mistake.
    expect(MANUAL).toMatch(/prorated to the time left/i);
  });

  it("names the trial length the code grants", () => {
    expect(MANUAL).toContain(`${SUBSCRIPTION_TRIAL_DAYS}-day`);
  });
});

describe("neither document restricts a tier to one currency", () => {
  // /help said "Pay in naira (Paystack) or US dollars (Stripe); the Enterprise
  // plan is billed in dollars only". Both halves were wrong: the platform sells
  // in THREE currencies, and no tier is restricted to any of them.
  //
  // CLAUDE.md records that exact "Enterprise is sold in dollars only" claim
  // being removed from the OPERATOR console as a stale one — and it was left
  // standing in the document a school owner reads. Corrected in one place and
  // not the other, which is the shape this file exists for.
  const currencies = planCurrencies(PLANS.ENTERPRISE);

  it("the premise: every tier is sold in the same set of currencies", () => {
    expect(currencies.length).toBeGreaterThan(1);
    for (const plan of Object.values(PLANS)) {
      expect(planCurrencies(plan)).toEqual(currencies);
    }
  });

  it("the guide no longer says a tier is billed in one currency only", () => {
    expect(help).not.toMatch(/billed in dollars only/i);
    expect(help).not.toMatch(/Enterprise[^."]{0,60}dollars only/i);
  });

  it("nor does it name a fixed pair of currencies as the whole set", () => {
    // "naira or US dollars" was true when the platform sold in two and became a
    // claim nobody rechecked when GHS opened. The guide points at the page,
    // which reads the real list.
    const prose = help.replace(/\s+/g, " ");
    expect(prose).not.toMatch(/Pay in naira \(Paystack\) or US dollars \(Stripe\)/i);
  });

  it("tells the reader where the real, per-school answer is", () => {
    expect(help).toMatch(/which of them the payment provider can settle/i);
  });
});

describe("the add-on shop is explained to the people who can use it", () => {
  it("/help describes buying and cancelling one", () => {
    // It had NO mention of add-ons at all, while the manual told owners to
    // email support for something self-serve.
    expect(help).toMatch(/add-on shop/i);
    expect(help).toMatch(/cancel it yourself/i);
  });

  it("both documents state the prorating rule", () => {
    // Without it the small first charge reads as a mistake.
    expect(help).toMatch(/prorated to the time left/i);
    expect(MANUAL).toMatch(/prorated to the time left/i);
  });
});
