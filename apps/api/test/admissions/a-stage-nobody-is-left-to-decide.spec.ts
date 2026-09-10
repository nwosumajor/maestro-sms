// =============================================================================
// An application waiting on a role that has since become vacant
// =============================================================================
// The review chain (School administrator -> Principal) is resolved to what the
// school could staff WHEN THE APPLICATION ARRIVED and stored on the row. Two
// guards keep it satisfiable from there, and both look forward:
//
//   - `resolveChain` drops a stage nobody could staff at SUBMIT time;
//   - `review` refuses an approval that would leave the REST of the chain
//     impossible ("You are the only Principal (final) approver...").
//
// Neither can reach the case where the approver LEAVES while the application
// waits. Measured live on a 5,000-school fleet: **252 applications** — 5% of
// everything waiting at the principal stage — sat at a stage with no ACTIVE
// holder. Driven end to end on one of them:
//
//   the departed principal logs in        -> 401 (exited users cannot)
//   the registrar tries to APPROVE        -> 403 "You are not the Principal (final) approver"
//   the registrar tries to REJECT         -> 403, the same
//   the queue shows it                    -> status REVIEWING, like ordinary work
//
// There is no reassign and no reset. The family waits for an answer that can
// never come, and nothing anywhere says so.
//
// The school already holds the lever — appoint somebody to the role and it
// moves — so being TOLD is the fix. Pinned here: the flag on the row, the
// school-wide count that a filter cannot hide, and a refusal that names the
// real problem instead of a true and useless one.
// =============================================================================

import { AdmissionsService } from "../../src/admissions/admissions.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const CHAIN = [
  { key: "ADMIN", label: "School administrator", permission: "admission.review" },
  { key: "PRINCIPAL", label: "Principal (final)", permission: "workflow.review.principal" },
];

type Row = {
  id: string;
  schoolId: string;
  status: string;
  currentStage: number;
  stages: unknown;
  approvals: unknown;
  childName: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  childDob: Date | null;
  desiredClass: string | null;
  details: unknown;
  examDate: Date | null;
  examNote: string | null;
  reviewNote: string | null;
  formFeeMinor: number;
  formFeePaidAt: Date | null;
  convertedStudentId: string | null;
  createdAt: Date;
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "app-1", schoolId: "A", status: "REVIEWING", currentStage: 1, stages: CHAIN, approvals: [],
  childName: "Femi", applicantName: "Bola", applicantEmail: "b@f.test", applicantPhone: null,
  childDob: null, desiredClass: "Year 7", details: null, examDate: null, examNote: null,
  reviewNote: null, formFeeMinor: 0, formFeePaidAt: null, convertedStudentId: null,
  createdAt: new Date("2026-09-01"), ...over,
});

/** @param vacant permissions this school has no ACTIVE holder for. */
function makeService(rows: Row[], vacant: string[] = []) {
  const tx = {
    admissionApplication: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      count: jest.fn(async () => rows.length),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    // The grouped extraction, honouring the predicate the query carries: only
    // NEW/REVIEWING rows, grouped by the permission of the stage they await.
    $queryRaw: jest.fn(async (q: { strings?: string[] }) => {
      const sql = (q?.strings ?? []).join("?");
      if (!/admission_application/.test(sql)) return [];
      const by = new Map<string, number>();
      for (const r of rows) {
        if (r.status !== "NEW" && r.status !== "REVIEWING") continue;
        const perm = (r.stages as typeof CHAIN)[r.currentStage]?.permission;
        if (perm) by.set(perm, (by.get(perm) ?? 0) + 1);
      }
      return [...by].map(([perm, n]) => ({ perm, n }));
    }),
    user: {
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        vacant.some((perm) => JSON.stringify(where).includes(perm)) ? 0 : 1,
      ),
    },
  } as unknown as TenantTx;
  const service = new AdmissionsService(
    { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
    { record: jest.fn() } as never,
    { deliver: jest.fn() } as never,
    { isConfigured: () => false } as never,
    { effective: jest.fn() } as never,
    { client: null } as never,
    { forSchool: jest.fn() } as never,
    { promoteApplicationInTx: jest.fn() } as never,
  );
  return { service, tx };
}

const officer: Principal = {
  schoolId: "A",
  userId: "adm-1",
  roles: ["school_admin"],
  permissions: ["admission.review", "workflow.review"],
};

describe("an application nobody is left to decide", () => {
  it("says so on the row — it is not ordinary pending work", async () => {
    const { service } = makeService([row()], ["workflow.review.principal"]);
    const page = await service.list(officer);
    expect(page.items[0]).toMatchObject({ status: "REVIEWING", stageLabel: "Principal (final)", stageBlocked: true });
  });

  it("does NOT flag one whose stage is staffed", async () => {
    const { service } = makeService([row()], []);
    expect((await service.list(officer)).items[0].stageBlocked).toBe(false);
  });

  it("does not flag a DECIDED application — it waits on nobody", async () => {
    const { service } = makeService([row({ status: "ACCEPTED" })], ["workflow.review.principal"]);
    const item = (await service.list(officer)).items[0];
    expect(item).toMatchObject({ stageLabel: null, stageBlocked: false });
  });

  it("counts them school-wide, so a filter cannot hide a stuck family", async () => {
    const { service } = makeService(
      [row({ id: "a" }), row({ id: "b" }), row({ id: "c", currentStage: 0, status: "NEW" })],
      ["workflow.review.principal"],
    );
    // Two wait at the vacant principal stage; the third waits at a staffed one.
    expect((await service.list(officer)).blockedTotal).toBe(2);
  });

  it("counts nothing when every stage is staffed", async () => {
    const { service } = makeService([row(), row({ id: "b" })], []);
    expect((await service.list(officer)).blockedTotal).toBe(0);
  });

  it("asks the database ONCE per distinct permission, not once per application", async () => {
    // The chain has two stages, so a page of any size costs at most two holder
    // counts. A count per row is a query multiplier over a table that only grows.
    const many = Array.from({ length: 50 }, (_, i) => row({ id: `a${i}` }));
    const { service, tx } = makeService(many, ["workflow.review.principal"]);
    await service.list(officer);
    const counts = (tx as unknown as { user: { count: jest.Mock } }).user.count.mock.calls.length;
    expect(counts).toBeLessThanOrEqual(4);
  });

  it("the REFUSAL names the real problem and the way out", async () => {
    // "You are not the Principal (final) approver" is true and useless: it
    // describes the caller when the fact that matters is that NOBODY here can
    // decide it, and that appointing someone is what unsticks it.
    const { service } = makeService([row()], ["workflow.review.principal"]);
    const message = await service.review(officer, "app-1", "APPROVE").catch((e: Error) => e.message);
    expect(message).toMatch(/nobody at this school can decide/i);
    expect(message).toMatch(/appoint/i);
    // REJECT is refused the same way — it is equally undecidable, and a
    // registrar reaching for the other button must not be told something else.
    const rejectMessage = await service.review(officer, "app-1", "REJECT").catch((e: Error) => e.message);
    expect(rejectMessage).toBe(message);
  });

  it("still gives the ORDINARY refusal when the role is merely somebody else's", async () => {
    // The vacancy message must not swallow the everyday case, or it would tell
    // a registrar the principal's chair is empty while the principal is in it.
    const { service } = makeService([row()], []);
    await expect(service.review(officer, "app-1", "APPROVE")).rejects.toThrow(
      /you are not the Principal \(final\) approver/i,
    );
  });
});
