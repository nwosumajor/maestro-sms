// =============================================================================
// Platform staff — hiring a manager who can actually sign in
// =============================================================================
// Hiring created the account, called EmailService.send, and returned a DTO with
// no link and no password. EmailService answers ok:true when it has NO provider
// configured — it logs an `[email-stub]` line and sends nothing — so on any
// deployment without email (the default), this produced a manager that NOBODY on
// earth could sign in as, with every step reporting success, and no resend path
// to recover: the email is globally unique, so the owner could not even re-hire
// the same person.
//
// The same failure shape as the payment bugs: the system reports success while
// the outcome never happens.
//
// These pin the three properties that make it operable:
//   • the owner GETS the link, because they may be the only delivery path;
//   • "emailed" means emailed, not "we called a function that did not throw";
//   • an invite can be re-issued, and only for a real, active manager.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { OperatorProvisioningService } from "../../src/operator/operator-provisioning.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const OWNER: Principal = {
  schoolId: "platform-org",
  userId: "owner-1",
  roles: ["super_admin"],
  permissions: ["platform.staff.manage"],
};

const ORG = { id: "platform-org", name: "MAESTRO-SMS", slug: "maestro" };

// The invite link is a SIGNED token, so minting one needs the signing secret.
// That is the point: the link is not a guessable URL, it is a credential.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-invite-signing";
  process.env.PUBLIC_WEB_URL = "https://console.example";
});
afterAll(() => {
  delete process.env.AUTH_SECRET;
  delete process.env.PUBLIC_WEB_URL;
});

const STAFF_ROW = {
  id: "u-mgr",
  email: "mgr@company.com",
  name: "Ada Manager",
  status: "ACTIVE",
  mfaEnabled: false,
  passwordChangedAt: null as Date | null,
  createdAt: new Date("2026-01-01"),
  disabledAt: null,
  lastLoginAt: null,
  locked: false,
};

function makeService(over: Record<string, unknown> = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const email = {
    isConfigured: () => over.emailConfigured === true,
    send: jest.fn(async (to: string, subject: string, text: string) => {
      sent.push({ to, subject, text });
      // The real service returns ok:true when unconfigured. Modelled exactly,
      // because that behaviour IS the bug these tests exist for.
      return (over.emailResult as { ok: boolean }) ?? { ok: true };
    }),
  };

  const created = { id: "u-mgr", email: STAFF_ROW.email, name: STAFF_ROW.name, status: "ACTIVE", createdAt: STAFF_ROW.createdAt };
  const db = {
    school: { findFirst: jest.fn().mockResolvedValue(ORG) },
    role: { findFirst: jest.fn().mockResolvedValue({ id: "role-mgr" }) },
    user: {
      findFirst: jest.fn().mockResolvedValue((over.existingUser as unknown) ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue(created),
    },
    userRole: { create: jest.fn(), deleteMany: jest.fn() },
    platformDelegation: {
      findMany: jest.fn().mockResolvedValue((over.delegations as unknown[]) ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: (over.revokedCount as number) ?? 0 }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { create: jest.fn().mockResolvedValue(created) }, userRole: { create: jest.fn() } }),
    ),
  };

  const privileged = { client: db };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const tenantDb = {
    runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({ auditLog: { create: jest.fn() } }),
  };

  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const svc = new OperatorProvisioningService(
    tenantDb as never, audit as never, privileged as never, notifications as never, email as never,
  );
  return { svc, db, email, sent };
}

// The service's constructor arity varies with unrelated deps; if this ever fails
// to construct, the assertions below would silently not run. Guard it.
describe("service constructs", () => {
  it("builds", () => {
    expect(makeService().svc).toBeInstanceOf(OperatorProvisioningService);
  });
});

describe("hiring a platform manager", () => {
  it("RETURNS the set-password link to the owner", async () => {
    // THE fix. Without this the account is unreachable on any deployment whose
    // email is not configured — which is the default.
    const { svc } = makeService();
    const out = await svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name });
    expect(out.inviteLink).toContain("/welcome?token=");
    expect(out.staff.email).toBe(STAFF_ROW.email);
  });

  it("reports emailDelivered FALSE when no provider is configured", async () => {
    // EmailService returns ok:true with no provider. "It did not throw" is not
    // "a human received it", and the owner must be told which.
    const { svc } = makeService({ emailConfigured: false });
    const out = await svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name });
    expect(out.emailDelivered).toBe(false);
  });

  it("reports emailDelivered TRUE only when configured AND the send succeeded", async () => {
    const ok = makeService({ emailConfigured: true, emailResult: { ok: true } });
    await expect(
      ok.svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name }),
    ).resolves.toMatchObject({ emailDelivered: true });

    const failed = makeService({ emailConfigured: true, emailResult: { ok: false } });
    await expect(
      failed.svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name }),
    ).resolves.toMatchObject({ emailDelivered: false });
  });

  it("emails the same link it hands back — one token, not two", async () => {
    // Two separately-minted tokens would both be valid, so revoking or auditing
    // one would say nothing about the other.
    const { svc, sent } = makeService({ emailConfigured: true });
    const out = await svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(out.inviteLink);
    expect(sent[0].to).toBe(STAFF_ROW.email);
  });

  it("still never returns or emails a PASSWORD", async () => {
    // The posture is unchanged: send links, never secrets. The link is single-use
    // and expiring; a password is neither.
    const { svc, sent } = makeService({ emailConfigured: true });
    const out = await svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name });
    expect(JSON.stringify(out)).not.toMatch(/password/i);
    expect(sent[0].text).not.toMatch(/temporary password|your password is/i);
  });

  it("refuses an email already in use", async () => {
    const { svc } = makeService({ existingUser: { id: "someone" } });
    await expect(
      svc.createPlatformStaff(OWNER, { email: STAFF_ROW.email, name: STAFF_ROW.name }),
    ).rejects.toThrow(/already in use/);
  });
});

describe("re-issuing an invite", () => {
  it("mints a fresh link for a real manager", async () => {
    const { svc } = makeService({ existingUser: STAFF_ROW });
    const out = await svc.reissuePlatformStaffInvite(OWNER, "u-mgr");
    expect(out.inviteLink).toContain("/welcome?token=");
  });

  it("404s an id that is not a platform manager", async () => {
    const { svc } = makeService({ existingUser: null });
    await expect(svc.reissuePlatformStaffInvite(OWNER, "u-owner")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("LOOKS UP the target scoped to the platform org's managers", async () => {
    // The most dangerous line in this file. An unscoped userId would mint a
    // credential-setting link for ANY account — the owner's included.
    //
    // Asserted on the QUERY, not on the 404. A mock returns null whatever it is
    // asked, so "it 404s" passes even with the scoping deleted — which it did,
    // until this test existed. The 404 above proves the branch; this proves the
    // reason for it.
    const { svc, db } = makeService({ existingUser: null });
    await expect(svc.reissuePlatformStaffInvite(OWNER, "u-owner")).rejects.toBeInstanceOf(NotFoundException);
    const where = (db.user.findFirst as jest.Mock).mock.calls.at(-1)![0].where;
    expect(where.id).toBe("u-owner");
    expect(where.schoolId).toBe(ORG.id);
    expect(where.roles.some.role.name).toBe("manager_admin");
  });

  it("refuses a DISABLED manager rather than quietly reviving them", async () => {
    // acceptInvite already refuses a non-ACTIVE account, so a link would be dead
    // on arrival — failing here says why instead of handing over a dud.
    const { svc } = makeService({ existingUser: { ...STAFF_ROW, status: "DISABLED" } });
    await expect(svc.reissuePlatformStaffInvite(OWNER, "u-mgr")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("handing back every duty at once", () => {
  it("revokes all live delegations and reports how many", async () => {
    // "This person is leaving" is one decision and must be one click. Revoking
    // grants one at a time under pressure is how the last one gets missed — and
    // the guard reads this table on every miss, so a missed grant is live access.
    const { svc, db } = makeService({ existingUser: STAFF_ROW, revokedCount: 3 });
    await expect(svc.revokeAllDuties(OWNER, "u-mgr")).resolves.toEqual({ revoked: 3 });
    const where = (db.platformDelegation.updateMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "u-mgr", revokedAt: null });
    // Only LIVE grants: already-expired rows are history and must keep their dates.
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("stamps who revoked and when", async () => {
    const { svc, db } = makeService({ existingUser: STAFF_ROW, revokedCount: 1 });
    await svc.revokeAllDuties(OWNER, "u-mgr");
    const data = (db.platformDelegation.updateMany as jest.Mock).mock.calls[0][0].data;
    expect(data.revokedById).toBe(OWNER.userId);
    expect(data.revokedAt).toBeInstanceOf(Date);
  });

  it("404s a non-manager, and scopes the lookup to prove why", async () => {
    // Same reasoning as the invite route: assert the query, because a mock will
    // 404 for any input and hide a deleted scope.
    const { svc, db } = makeService({ existingUser: null });
    await expect(svc.revokeAllDuties(OWNER, "u-owner")).rejects.toBeInstanceOf(NotFoundException);
    const where = (db.user.findFirst as jest.Mock).mock.calls.at(-1)![0].where;
    expect(where.schoolId).toBe(ORG.id);
    expect(where.roles.some.role.name).toBe("manager_admin");
  });
});

describe("the staff list answers 'who can do what, right now'", () => {
  it("attaches each manager's LIVE duties with a countdown", async () => {
    const in5 = new Date(Date.now() + 5 * 86_400_000);
    const { svc, db } = makeService({
      delegations: [
        { id: "d-1", userId: "u-mgr", permission: "platform.audit.read", reason: "incident review", expiresAt: in5 },
      ],
    });
    (db.user.findMany as jest.Mock).mockResolvedValue([STAFF_ROW]);

    const list = await svc.listPlatformStaff(OWNER);
    expect(list).toHaveLength(1);
    expect(list[0].duties).toEqual([
      expect.objectContaining({ permission: "platform.audit.read", reason: "incident review", daysLeft: 5 }),
    ]);
    expect(list[0].lastLoginAt).toBeNull();
    expect(list[0].activated).toBe(false);
  });

  it("asks for LIVE grants only — expired and handed-back ones are history", async () => {
    // Showing an expired grant as a current duty would misreport access; the
    // delegations screen keeps them for "who had this in March".
    const { svc, db } = makeService();
    (db.user.findMany as jest.Mock).mockResolvedValue([STAFF_ROW]);
    await svc.listPlatformStaff(OWNER);
    const where = (db.platformDelegation.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("fetches every manager's duties in ONE query, not one per manager", async () => {
    // The console is where you look when something is wrong. It must not be the
    // slowest page on the platform.
    const { svc, db } = makeService();
    (db.user.findMany as jest.Mock).mockResolvedValue([STAFF_ROW, { ...STAFF_ROW, id: "u-mgr2" }]);
    await svc.listPlatformStaff(OWNER);
    expect((db.platformDelegation.findMany as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((db.platformDelegation.findMany as jest.Mock).mock.calls[0][0].where.userId.in).toEqual(["u-mgr", "u-mgr2"]);
  });
});
