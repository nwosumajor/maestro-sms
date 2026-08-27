// =============================================================================
// The term lock was checked when the amendment was raised, not when it applied
// =============================================================================
// A register older than STALE_REGISTER_DAYS cannot be corrected by a plain
// teacher directly: it raises an ATTENDANCE_AMENDMENT that a DIFFERENT senior
// approves, and a WorkflowHooks reactor applies the marks in-tx.
//
// The term lock — "a register in a term that has ENDED is read-only for
// everyone, including leadership" — is checked in two places: when the
// amendment is RAISED, and on the direct-write path. The reactor called
// `applyRegister`, the low-level write, with NEITHER.
//
// Approval happens later, and a term roll-over is a nightly job. So an amendment
// raised inside the current term could sit pending while the term closed, and
// approving it then wrote into a frozen register. CLAUDE.md states the rule as
// "fully LOCKED (409), no edit EVEN WITH APPROVAL" — and this was the one path
// where an approval was the thing doing it.
//
// It matters because a closed term is treated as frozen everywhere else: the
// report card for it is already printed and filed in the vault, and
// `attendance_term_rollup` is already computed. Neither follows a register that
// moves afterwards.
// =============================================================================

import { ConflictException } from "@nestjs/common";
import { AttendanceService } from "../../src/attendance/attendance.service";

const RAISED_FOR = "2026-05-04"; // inside the term it was raised in

describe("a term that closed while the amendment waited", () => {
  it("refuses to apply once that term has closed", async () => {
    const { run, applied } = reactorWith({ currentTermStartsOn: "2026-09-07" });
    await expect(run()).rejects.toBeInstanceOf(ConflictException);
    expect(applied).toHaveLength(0);
  });

  it("says WHY, naming the term boundary rather than a bare refusal", async () => {
    const { run } = reactorWith({ currentTermStartsOn: "2026-09-07" });
    await expect(run()).rejects.toThrow(/closed while this amendment was awaiting approval/i);
  });

  it("still applies when the term is the same one it was raised in", async () => {
    const { run, applied } = reactorWith({ currentTermStartsOn: "2026-04-01" });
    await run();
    expect(applied).toHaveLength(1);
    expect(applied[0].date.toISOString().slice(0, 10)).toBe(RAISED_FOR);
  });

  it("applies when the school has no term boundary configured at all", async () => {
    // Fail-open matches the direct-write path: `currentTermStart` returning null
    // means unconfigured, and refusing every correction on that basis would be a
    // worse answer than allowing one.
    const { run, applied } = reactorWith({ currentTermStartsOn: null });
    await run();
    expect(applied).toHaveLength(1);
  });

  it("throws rather than skipping, so the approval rolls back with it", async () => {
    // The hook runs in the SAME transaction as the transition. Applying nothing
    // while recording APPROVED would leave the approver believing a register had
    // been corrected — the silent-success shape this repo keeps finding.
    const { run } = reactorWith({ currentTermStartsOn: "2026-09-07" });
    await expect(run()).rejects.toBeTruthy();
  });
});

function reactorWith(opts: { currentTermStartsOn: string | null }) {
  const applied: Array<{ date: Date }> = [];
  let onFinalized: ((tx: unknown, req: unknown) => Promise<void>) | null = null;

  // Constructed for real: the reactor is registered IN THE CONSTRUCTOR, so an
  // Object.create() instance never wires it up at all — the fixture would test
  // nothing and pass.
  const svc = new AttendanceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { todayInTx: async () => new Date("2026-10-01") } as never,
    {
      onFinalized: (fn: (tx: unknown, req: unknown) => Promise<void>) => {
        onFinalized = fn;
      },
    } as never,
  );
  if (!onFinalized) throw new Error("the reactor was never registered");

  // Intercept only the low-level write; the term-lock read is the REAL one.
  (svc as unknown as { applyRegister: unknown }).applyRegister = async (
    _tx: unknown,
    _s: string,
    _u: string,
    _c: string,
    date: Date,
  ) => {
    applied.push({ date });
    return { session: {}, alerts: [] };
  };

  const tx = {
    term: {
      findFirst: async (a: { where?: { isCurrent?: boolean } }) =>
        a.where?.isCurrent && opts.currentTermStartsOn
          ? { startDate: new Date(opts.currentTermStartsOn) }
          : null,
    },
  };
  const req = {
    id: "req-1",
    type: "ATTENDANCE_AMENDMENT",
    state: "APPROVED",
    schoolId: "s1",
    initiatorId: "teacher-1",
    payload: { classId: "c1", date: RAISED_FOR, records: [{ studentId: "p1", status: "PRESENT" }] },
  };
  const fire = onFinalized as (tx: unknown, req: unknown) => Promise<void>;
  return { run: () => fire(tx, req), applied };
}
