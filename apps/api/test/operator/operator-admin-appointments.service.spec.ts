// =============================================================================
// OperatorService.listAdminAppointments — cross-tenant junior-admin oversight
// =============================================================================
// The operator sees every tenant's ADMIN_APPOINTMENT maker-checker requests
// (school + initiator + target + state), read via the PRIVILEGED client like
// the registry. Degrades to [] when the privileged URL is unset, and the
// ?state= filter narrows the query.

import { OperatorService } from "../../src/operator/operator.service";

function makeService(rows: Record<string, unknown>[] | null) {
  const findMany = jest.fn().mockResolvedValue(rows ?? []);
  const client =
    rows === null
      ? null
      : {
          workflowRequest: { findMany },
          school: {
            findMany: jest.fn().mockResolvedValue([{ id: "school-A", name: "St. Andrews" }]),
          },
          user: {
            findMany: jest.fn().mockResolvedValue([
              { id: "senior-1", name: "Senior Admin", email: "admin@a" },
              { id: "target-1", name: "New Junior", email: "jr@a" },
            ]),
          },
        };
  const db = { runAsTenant: jest.fn() };
  const audit = { record: jest.fn() };
  const entitlements = {};
  const privileged = { client };
  const service = new OperatorService(db as never, audit as never, entitlements as never, privileged as never);
  return { service, findMany };
}

const row = {
  id: "wf-1",
  schoolId: "school-A",
  state: "PENDING_REVIEW",
  payload: { userId: "target-1", roleName: "junior_admin" },
  initiatorId: "senior-1",
  createdAt: new Date("2026-07-19T10:00:00Z"),
  updatedAt: new Date("2026-07-19T10:05:00Z"),
};

describe("OperatorService.listAdminAppointments", () => {
  it("returns [] when the privileged client is not configured", async () => {
    const { service } = makeService(null);
    await expect(service.listAdminAppointments()).resolves.toEqual([]);
  });

  it("enriches requests with school, initiator and target (payload-resolved)", async () => {
    const { service } = makeService([row]);
    const out = await service.listAdminAppointments();
    expect(out).toEqual([
      expect.objectContaining({
        requestId: "wf-1",
        schoolName: "St. Andrews",
        state: "PENDING_REVIEW",
        roleName: "junior_admin",
        targetUserName: "New Junior",
        targetUserEmail: "jr@a",
        initiatorName: "Senior Admin",
      }),
    ]);
  });

  it("passes the state filter into the query", async () => {
    const { service, findMany } = makeService([]);
    await service.listAdminAppointments("PENDING_REVIEW");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ type: "ADMIN_APPOINTMENT", state: "PENDING_REVIEW" });
  });
});
