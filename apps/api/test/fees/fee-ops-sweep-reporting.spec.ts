// =============================================================================
// The fee sweeps say whether they RAN — not just what they found
// =============================================================================
// lateFeeSweep and reminderSweep returned zeros in silence when no privileged
// DB was configured, and the processor then logged "done: schools=0 applied=0".
// An environment missing DATABASE_MIGRATE_URL therefore applies no late fee to
// any school and chases no overdue parent, FOR EVER, while the nightly log
// reports success. Every sibling sweep — dunning, reconciliation, mobile-money
// recovery, retention, audit partitions — warns in this case; these two were
// the exception.
// =============================================================================

import { Logger } from "@nestjs/common";
import { notificationsStub } from "../support/notifications-stub";
import { FeeOpsService, LATE_FEE_JOB, REMINDER_JOB } from "../../src/fees/fee-ops.service";
import { FeeOpsProcessor } from "../../src/fees/fee-ops.processor";

/** The job-run recorder, stubbed: it runs the work and records nothing. These
 *  suites are about what a sweep REPORTS, not about its run history. */
const norecord = { record: <T,>(_j: string, _t: string, fn: () => Promise<T>) => fn() } as never;


/** A service with NO privileged client — the misconfigured environment. */
function unconfigured() {
  return new FeeOpsService(
    { runAsTenant: jest.fn() } as never,
    { record: jest.fn() } as never,
    notificationsStub() as never,
    { client: null } as never,
    {} as never,
  );
}

describe("fee sweeps report a skip as a skip", () => {
  let warned: string[];
  let logged: string[];
  beforeEach(() => {
    warned = [];
    logged = [];
    jest.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => { warned.push(String(m)); });
    jest.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { logged.push(String(m)); });
  });
  afterEach(() => jest.restoreAllMocks());

  it("the late-fee sweep WARNS rather than returning a quiet zero", async () => {
    const r = await unconfigured().lateFeeSweep();
    expect(r).toMatchObject({ schools: 0, feesApplied: 0, skipped: true });
    expect(warned.join(" ")).toMatch(/no privileged DB/i);
  });

  it("the reminder sweep WARNS rather than returning a quiet zero", async () => {
    const r = await unconfigured().reminderSweep();
    expect(r).toMatchObject({ schools: 0, reminded: 0, skipped: true });
    expect(warned.join(" ")).toMatch(/no privileged DB/i);
  });

  // The log line is what an operator actually reads back, so the distinction
  // has to survive into it — not merely exist on the return value.
  it("the processor's line distinguishes SKIPPED from 'nothing overdue'", async () => {
    const processor = new FeeOpsProcessor(unconfigured(), norecord);
    await processor.process({ name: LATE_FEE_JOB } as never);
    await processor.process({ name: REMINDER_JOB } as never);
    expect(logged.join(" ")).toMatch(/SKIPPED/);
    expect(logged.join(" ")).not.toMatch(/done: schools=0/);
  });
});
