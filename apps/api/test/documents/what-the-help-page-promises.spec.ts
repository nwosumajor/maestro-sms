/**
 * Two claims in the guide everybody reads, both wrong about what to do next.
 *
 * 1. "three failed sign-ins lock the account until an administrator reactivates
 *    it". NO administrator in a school can. The only unlock route in the product
 *    is `POST /operator/tenants/:schoolId/users/:userId/unlock`, gated on
 *    `platform.user.credentials` — held by super_admin alone — and there is no
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
});
