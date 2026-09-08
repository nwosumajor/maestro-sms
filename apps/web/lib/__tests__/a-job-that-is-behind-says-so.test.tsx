// =============================================================================
// A sweep that is BEHIND must not render as OK
// =============================================================================
// The console flags a job when it never ran, is late, fired too often, errored,
// or reported failures. None of those catches the case that actually bit: a
// capped sweep that did everything it was allowed to and left the rest.
//
// Measured on a 3,500-school fleet after a queue outage stranded 21,918
// deliveries: the hourly recovery run returned scanned=500 requeued=500
// failed=0 — lastOk true, nothing late, nothing failed — while 21,858 families
// were still waiting. Every signal on this table was green.
// =============================================================================

import { render, screen } from "@testing-library/react";

// The component is a client island: it formats dates in the SCHOOL's region and
// refreshes the route after a manual run. A double must model the contract, not
// just satisfy the import.
jest.mock("../../components/shell/RegionProvider", () => ({
  useFormat: () => ({ shortDate: (d: string) => String(d).slice(0, 10) }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { JobsTable } from "../../components/operator/JobsTable";

const job = (over: Record<string, unknown> = {}) => ({
  key: "notifications.deliveryRecovery",
  label: "Notification delivery recovery",
  description: "Re-queues deliveries nobody was going to look at again",
  cadence: "hourly",
  scope: "PLATFORM",
  neverRun: false,
  overdue: false,
  overrunning: false,
  lastOk: true,
  lastRunAt: new Date().toISOString(),
  lastError: null,
  lastSummary: { scanned: 500, requeued: 500, failed: 0, backlog: 20885 },
  lastFailed: 0,
  lastBacklog: 20885,
  ...over,
});

describe("the jobs console", () => {
  it("marks a job with a backlog as a problem, not as OK", () => {
    render(<JobsTable jobs={[job()] as never} permissions={["platform.operate"]} />);
    expect(screen.getByText("Behind")).toBeInTheDocument();
    expect(screen.queryByText("OK")).toBeNull();
  });

  it("COUNTS it as needing attention, not just badges the row", () => {
    // The badge and the header count are driven by DIFFERENT code. A first
    // version of this test only checked the badge, so removing the backlog from
    // the attention predicate left it green — the mutation proved the test, not
    // the fix. The header is what an operator reads before scrolling.
    render(<JobsTable jobs={[job()] as never} permissions={["platform.operate"]} />);
    expect(screen.getByText(/needs? attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/finished cleanly/i)).toBeNull();
  });

  it("says HOW FAR behind — the number is the diagnosis", () => {
    render(<JobsTable jobs={[job()] as never} permissions={["platform.operate"]} />);
    // Whether the sweep is keeping up is the question a backlog answers, and it
    // cannot be answered without the magnitude.
    expect(screen.getByText(/20,885/)).toBeInTheDocument();
  });

  it("still says OK when the sweep genuinely cleared everything", () => {
    render(<JobsTable jobs={[job({ lastBacklog: 0, lastSummary: { scanned: 12, requeued: 12, failed: 0, backlog: 0 } })] as never} permissions={["platform.operate"]} />);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.queryByText("Behind")).toBeNull();
  });

  it("a job that reports no backlog at all is not accused of one", () => {
    // The convention is OPT-IN: null means "this job has no notion of a
    // backlog", which is different from zero and must not render as an alarm.
    render(<JobsTable jobs={[job({ lastBacklog: null, lastSummary: { ok: true } })] as never} permissions={["platform.operate"]} />);
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("a real FAILURE still outranks a backlog — it is the worse fact", () => {
    render(<JobsTable jobs={[job({ lastFailed: 3 })] as never} permissions={["platform.operate"]} />);
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });
});
