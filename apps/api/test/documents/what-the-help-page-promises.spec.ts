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
import { ESSENTIAL_NOTIFICATION_TYPES, allowedChannels } from "@sms/types";

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
    const cover = readFileSync(join(API, "attendance/attendance.service.ts"), "utf8");
    const declared = cover.match(/REGISTER_COVER_ROLES[^=]*=\s*(?:new Set\()?\[([^\]]*)\]/);
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
