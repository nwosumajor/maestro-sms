// =============================================================================
// Two producers of the same telemetry, one consent-gated and one not
// =============================================================================
// `IntegritySignal` rows are behavioural telemetry about a minor, and Golden
// Rule #5 binds them to NDPR consent. `IntegrityService.ingestClientSignals`
// enforces that properly: it refuses to persist without consent for the child
// AND without the assessment's monitoring flag, and `runDetection` re-checks
// consent afterwards as defence in depth, so telemetry captured before a
// withdrawal is never analysed.
//
// `CbtService.recordIntegrityEvents` writes the SAME TABLE, with the SAME two
// types — PASTE and FOCUS_LOSS, client-observed, about a child sitting an exam —
// and the service had no consent dependency at all. Built later, in another
// module, against a rule that lives in the module it was not built in.
//
// Found by sweeping every write to the three telemetry tables and asking which
// of them passes the gate: four did, one did not.
//
// DROPPED, NOT REFUSED. Withholding consent for monitoring must never cost a
// child their paper: the sitting proceeds exactly as before and the endpoint
// answers normally, it simply records nothing. Same posture as the assessment
// path, which returns quietly rather than erroring.
//
// Retention was checked at the same time and is FINE: the purge deletes by
// `{ schoolId, createdAt < cutoff }` with no submission linkage, so exam-hall
// rows were always inside the window even though nothing gated their creation.
// =============================================================================

import { CbtService } from "../../src/cbt/cbt.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const STUDENT = "pupil-1";

function makeService(consented: boolean) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    cbtSitting: {
      findFirst: jest.fn().mockResolvedValue({ id: "sit-1", examId: "e1", status: "IN_PROGRESS" }),
    },
    integritySignal: { createMany, findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const hasIntegrityConsent = jest.fn().mockResolvedValue(consented);
  const svc = Object.create(CbtService.prototype) as CbtService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    consent: { hasIntegrityConsent },
    notifications: { enqueue: jest.fn() },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  (svc as unknown as { ctx: unknown }).ctx = (p: Principal) => ({ schoolId: p.schoolId, userId: p.userId });
  (svc as unknown as { alertIntegrity: unknown }).alertIntegrity = jest.fn().mockResolvedValue(false);
  return { svc, createMany, hasIntegrityConsent, tx };
}

const pupil: Principal = { schoolId: "A", userId: STUDENT, roles: ["student"], permissions: ["cbt.take"] };
const events = [
  { type: "FOCUS_LOSS", awayMs: 30_000 },
  { type: "PASTE", chars: 400 },
];
const record = (svc: CbtService) =>
  (svc as unknown as { recordIntegrityEvents: (p: Principal, id: string, e: unknown[]) => Promise<unknown> })
    .recordIntegrityEvents(pupil, "sit-1", events);

describe("a pupil whose family has NOT consented to integrity monitoring", () => {
  it("has nothing written about them", async () => {
    const t = makeService(false);
    await record(t.svc);
    expect(t.createMany).not.toHaveBeenCalled();
  });

  it("still sits the exam — the call answers normally", async () => {
    // The whole point of dropping rather than refusing. An error here would make
    // a withheld consent cost the child their paper.
    const t = makeService(false);
    await expect(record(t.svc)).resolves.toMatchObject({ recorded: 0, focusLosses: 0, awayMs: 0, alerted: false });
  });

  it("is not read back either, so no total is computed from nothing", async () => {
    const t = makeService(false);
    await record(t.svc);
    expect(t.tx.integritySignal.findMany).not.toHaveBeenCalled();
  });

  it("is asked about by the pupil's OWN id, not the caller's role", async () => {
    const t = makeService(false);
    await record(t.svc);
    expect(t.hasIntegrityConsent).toHaveBeenCalledWith({ studentId: STUDENT, schoolId: "A" }, expect.anything());
  });
});

describe("a pupil whose family HAS consented", () => {
  it("is recorded exactly as before", async () => {
    const t = makeService(true);
    await record(t.svc);
    expect(t.createMany).toHaveBeenCalledTimes(1);
    const rows = t.createMany.mock.calls[0][0].data as Array<{ type: string; source: string }>;
    expect(rows.map((r) => r.type).sort()).toEqual(["FOCUS_LOSS", "PASTE"]);
    expect(rows.every((r) => r.source === "CLIENT")).toBe(true);
  });

  it("is asked BEFORE anything is written, not after", async () => {
    // A check that runs after the insert is not a gate.
    const t = makeService(true);
    await record(t.svc);
    expect(t.hasIntegrityConsent.mock.invocationCallOrder[0]).toBeLessThan(
      t.createMany.mock.invocationCallOrder[0],
    );
  });
});

describe("the gate does not replace the checks already there", () => {
  it("a closed script still records nothing, consent or not", async () => {
    const t = makeService(true);
    (t.tx.cbtSitting.findFirst as jest.Mock).mockResolvedValue({ id: "sit-1", examId: "e1", status: "SUBMITTED" });
    await record(t.svc);
    expect(t.createMany).not.toHaveBeenCalled();
  });
});
