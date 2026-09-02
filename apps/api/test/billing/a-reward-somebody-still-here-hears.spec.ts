/**
 * A referral reward went to ONE person: whoever generated the code.
 *
 * Measured live, driving the real signed Paystack webhook — a bursar generated
 * the code and later left; the referring school earned three free months (its
 * period end moved 2027-06-21 -> 2027-09-21, a conversion was recorded) and the
 * ONLY notice went to that EXITED account. `NotificationService.persist` drops
 * every external channel for a non-ACTIVE recipient, so ZERO deliveries were
 * queued, and they cannot sign in to read the in-app row either. The school's
 * own school_admin and principal, both ACTIVE, were told nothing.
 *
 * Every OTHER billing notice — dunning, renewal, the grant-expiry warning —
 * already addresses the leadership ROLES with a `status: ACTIVE` filter. This
 * one did not, and it is the notice about money the school has EARNED.
 */
import { ReferralService } from "../../src/billing/referral.service";

type UserRow = { id: string; status: string; roles: string[] };

function svc(users: UserRow[]) {
  const asked: Array<Record<string, unknown>> = [];
  const tx = {
    user: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        asked.push(where);
        // The harness HONOURS the where — a stub that returns everyone models a
        // database that cannot filter, and the status assertion would pass
        // against a service that had stopped filtering.
        const wanted = ((where.roles as { some: { role: { name: { in: string[] } } } }).some.role.name.in) ?? [];
        return users
          .filter((u) => (where.status === undefined || u.status === where.status))
          .filter((u) => u.roles.some((r) => wanted.includes(r)))
          .map((u) => ({ id: u.id }));
      },
      findFirst: async ({ where }: { where: { id: string; status?: string } }) => {
        asked.push(where);
        const u = users.find((x) => x.id === where.id);
        if (!u) return null;
        if (where.status !== undefined && u.status !== where.status) return null;
        return { id: u.id };
      },
    },
  };
  const s = Object.create(ReferralService.prototype) as ReferralService;
  const call = (schoolId: string, creator: string | null) =>
    (s as unknown as {
      rewardRecipients: (tx: unknown, schoolId: string, creator: string | null) => Promise<string[]>;
    }).rewardRecipients(tx, schoolId, creator);
  return { call, asked };
}

const LEADERS: UserRow[] = [
  { id: "admin", status: "ACTIVE", roles: ["school_admin"] },
  { id: "head", status: "ACTIVE", roles: ["principal"] },
  { id: "teacher", status: "ACTIVE", roles: ["teacher"] },
];

describe("who hears that the school earned a free term", () => {
  it("tells the people who run the school", async () => {
    const { call } = svc(LEADERS);
    expect((await call("s1", null)).sort()).toEqual(["admin", "head"]);
  });

  // The person who did the referring, but only if they are still here — the
  // same question, asked of them as of everyone else.
  it("includes the code's creator when they are still here", async () => {
    const { call } = svc([...LEADERS, { id: "bursar", status: "ACTIVE", roles: ["accountant"] }]);
    expect((await call("s1", "bursar")).sort()).toEqual(["admin", "bursar", "head"]);
  });

  // THE DEFECT. A leaver is excluded rather than merely deprioritised:
  // addressing one is addressing nobody.
  it("excludes the code's creator once they have left", async () => {
    const { call } = svc([...LEADERS, { id: "bursar", status: "EXITED", roles: ["accountant"] }]);
    const out = await call("s1", "bursar");
    expect(out).not.toContain("bursar");
    expect(out.sort()).toEqual(["admin", "head"]);
  });

  it("excludes a leader who has left", async () => {
    const { call } = svc([
      { id: "admin", status: "EXITED", roles: ["school_admin"] },
      { id: "head", status: "ACTIVE", roles: ["principal"] },
    ]);
    expect(await call("s1", null)).toEqual(["head"]);
  });

  it("asks for ACTIVE people, not merely for the roles", async () => {
    const { call, asked } = svc(LEADERS);
    await call("s1", null);
    expect(asked[0]).toMatchObject({ schoolId: "s1", status: "ACTIVE" });
  });

  // A creator who is ALSO the principal must not be told twice.
  it("does not tell one person twice", async () => {
    const { call } = svc([{ id: "head", status: "ACTIVE", roles: ["principal"] }]);
    expect(await call("s1", "head")).toEqual(["head"]);
  });

  // A school with nobody active yields none — the caller logs it rather than
  // silently doing nothing, because the reward stands either way.
  it("returns nobody when there is nobody to tell", async () => {
    const { call } = svc([{ id: "admin", status: "EXITED", roles: ["school_admin"] }]);
    expect(await call("s1", null)).toEqual([]);
  });
});

/**
 * A test on the helper proves nothing about its caller — the seam that hid the
 * CBT score and the report-card promotion line. These read the two call sites.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../support/strip-comments";

const REFERRAL = stripComments(readFileSync(path.join(__dirname, "../../src/billing/referral.service.ts"), "utf8"));
const BILLING = stripComments(readFileSync(path.join(__dirname, "../../src/billing/billing.service.ts"), "utf8"));

describe("the reward notice reaches the set, not one person", () => {
  it("resolves the recipients through the shared rule", () => {
    expect(REFERRAL).toMatch(/referrerRecipientIds: await this\.rewardRecipients\(/);
    // The single-recipient field is gone, so nothing can quietly go back to it.
    expect(REFERRAL).not.toMatch(/referrerRecipientId\b[^s]/);
  });

  it("uses the same leadership set as the dunning sweep's grant notice", () => {
    expect(REFERRAL).toMatch(/REWARD_NOTICE_RECIPIENTS = \["principal", "school_admin"\]/);
  });

  // ONE transaction for the lot, like every other multi-recipient notice —
  // `enqueue` per recipient opens a transaction and a queue round trip each.
  it("sends them in one transaction", () => {
    const at = BILLING.indexOf("Referral reward earned");
    expect(at).toBeGreaterThan(-1);
    const around = BILLING.slice(Math.max(0, at - 900), at + 400);
    expect(around).toMatch(/enqueueMany\(/);
    expect(around).toMatch(/referrerRecipientIds/);
  });

  // NOT SILENT. A school that earned a free term and has nobody active to tell
  // is a fact the platform owner should be able to find afterwards.
  it("logs when there is nobody to tell rather than doing nothing", () => {
    expect(BILLING).toMatch(/no active principal or school_admin to notify/);
  });
});
