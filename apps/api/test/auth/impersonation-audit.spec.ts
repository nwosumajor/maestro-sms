// =============================================================================
// Impersonation must never be invisible in the audit log
// =============================================================================
// When the owner impersonates, the Principal genuinely IS the target — same
// tenant, roles and RLS. That is the point, but it means `actorId` on every
// audited action is the TARGET. Without the request-context stamp the trail would
// read "the parent downloaded this", with nothing tying it to the owner: an actor
// attribution hole (Golden Rule #5) that impersonation opens by design.

import { verifyToken } from "../../src/auth/jwt";
import { requestContext, currentImpersonator } from "../../src/auth/request-context";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import jwt from "jsonwebtoken";

const SECRET = "test-secret";
const base = { userId: "target-1", school_id: "school-a", roles: ["parent"], permissions: ["fee.read"] };

describe("impersonation — token claims", () => {
  const prev = process.env.AUTH_SECRET;
  beforeAll(() => { process.env.AUTH_SECRET = SECRET; });
  afterAll(() => { process.env.AUTH_SECRET = prev; });

  it("carries imp.by through as impersonatedBy", () => {
    const token = jwt.sign({ ...base, imp: { by: "owner-1" } }, SECRET, { algorithm: "HS256" });
    expect(verifyToken(token).impersonatedBy).toBe("owner-1");
  });

  it("a NORMAL token has no impersonatedBy (the flag is never invented)", () => {
    const token = jwt.sign(base, SECRET, { algorithm: "HS256" });
    expect(verifyToken(token).impersonatedBy).toBeUndefined();
  });

  it("impersonation grants nothing extra — claims are still only the target's", () => {
    const token = jwt.sign({ ...base, imp: { by: "owner-1" } }, SECRET, { algorithm: "HS256" });
    const p = verifyToken(token);
    expect(p.userId).toBe("target-1");
    expect(p.schoolId).toBe("school-a");
    expect(p.permissions).toEqual(["fee.read"]); // NOT the owner's platform powers
  });
});

describe("AuditLogService — impersonation attribution", () => {
  const entry = {
    actorId: "target-1",
    action: "fee.read",
    entity: "invoice",
    entityId: "inv-1",
    schoolId: "school-a",
  };
  const makeTx = () => ({ auditLog: { create: jest.fn().mockResolvedValue({}) } });

  it("stamps impersonatedBy onto the entry when the request is an impersonation", async () => {
    const tx = makeTx();
    await requestContext.run({ impersonatedBy: "owner-1" }, async () => {
      await new AuditLogService().record({ ...entry, metadata: { amount: 5 } }, tx as never);
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // actorId stays the TARGET — they really are the principal — but the entry
        // now says who was driving.
        data: expect.objectContaining({
          actorId: "target-1",
          metadata: { amount: 5, impersonatedBy: "owner-1" },
        }),
      }),
    );
  });

  it("adds nothing to a normal request (no context = no stamp)", async () => {
    const tx = makeTx();
    await requestContext.run({}, async () => {
      await new AuditLogService().record({ ...entry, metadata: { amount: 5 } }, tx as never);
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ metadata: { amount: 5 } }) }),
    );
  });

  it("stamps even when the caller passed no metadata at all", async () => {
    const tx = makeTx();
    await requestContext.run({ impersonatedBy: "owner-9" }, async () => {
      await new AuditLogService().record(entry, tx as never);
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ metadata: { impersonatedBy: "owner-9" } }) }),
    );
  });

  it("context is per-request: one impersonated request never leaks into another", async () => {
    await requestContext.run({ impersonatedBy: "owner-1" }, async () => {
      expect(currentImpersonator()).toBe("owner-1");
    });
    await requestContext.run({}, async () => {
      expect(currentImpersonator()).toBeUndefined();
    });
  });
});
