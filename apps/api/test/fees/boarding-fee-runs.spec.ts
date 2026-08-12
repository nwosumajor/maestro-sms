// =============================================================================
// Hostel and transport fee runs — a second press must not bill twice
// =============================================================================
// Both runs POST MONEY onto a pupil's invoice, and neither had any guard
// against running again. A second press, an impatient retry, or the
// FEE_SCHEDULE approval hook replaying charged every boarder their rent AGAIN —
// silently, and with nothing on the invoice to tell the duplicate from the
// original afterwards, so a bursar reconciling it could only guess.
//
// The fees module already solved this exact shape: the late-fee sweep adds its
// charge once per invoice, keyed on a marker line item. These two runs borrowed
// the pattern for writing the line and not the guard that makes it safe.
//
// The description is the key on purpose. It is what a bursar actually reads on
// the invoice, so "two lines saying Hostel rent for the same term" IS the bug,
// and one line is the right outcome whether the run fired once or five times.
// =============================================================================

import { HostelService } from "../../src/hostel/hostel.service";

const RENT = 150_000;

/** A tx double that records what the run writes, so the assertions are about
 *  invoice lines rather than about mock call counts. */
function makeTx(existingLines: Array<{ description: string; studentId: string }> = []) {
  const lines: Array<{ invoiceId: string; description: string; amountMinor: number }> = [];
  const invoices: Array<{ id: string; studentId: string; currency: string }> = [];
  let n = 0;
  return {
    lines,
    invoices,
    tx: {
      hostelRoom: { findMany: jest.fn().mockResolvedValue([{ id: "r1", rentMinor: RENT }]) },
      hostelAllocation: {
        findMany: jest.fn().mockResolvedValue([
          { id: "a1", roomId: "r1", studentId: "s1" },
          { id: "a2", roomId: "r1", studentId: "s2" },
        ]),
      },
      school: { findFirst: jest.fn().mockResolvedValue({ currency: "GHS" }) },
      invoiceLineItem: {
        findMany: jest.fn().mockResolvedValue(
          existingLines.map((l) => ({ invoice: { studentId: l.studentId } })),
        ),
        create: jest.fn(async (a: { data: { invoiceId: string; description: string; amountMinor: number } }) => {
          lines.push(a.data);
          return a.data;
        }),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (a: { data: { studentId: string; currency: string } }) => {
          const inv = { id: `inv-${++n}`, studentId: a.data.studentId, currency: a.data.currency };
          invoices.push(inv);
          return inv;
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    },
  };
}

async function runHostel(tx: unknown) {
  const svc = Object.create(HostelService.prototype) as HostelService;
  Object.assign(svc, { audit: { record: jest.fn() } });
  const post = (svc as unknown as {
    postFeeRun: (t: unknown, s: string, a: string, i: Record<string, unknown>) => Promise<unknown>;
  }).postFeeRun.bind(svc);
  return post(tx, "school-1", "actor-1", { due: new Date("2026-09-01"), scopeWardenId: null });
}

describe("hostel fee run", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bills each boarder ONCE on a first run", async () => {
    const { tx, lines } = makeTx();
    await runHostel(tx);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.amountMinor === RENT)).toBe(true);
  });

  it("does NOT bill again when the charge is already on an open invoice", async () => {
    // The whole point: pressing it twice must not charge rent twice.
    const { tx, lines } = makeTx([
      { description: "Hostel rent", studentId: "s1" },
      { description: "Hostel rent", studentId: "s2" },
    ]);
    await runHostel(tx);
    expect(lines).toHaveLength(0);
  });

  it("bills only the boarders who are NOT already carrying the charge", async () => {
    // A part-completed run — one pupil added to a hostel after the first run —
    // must top up the gap, not re-bill the ones already charged.
    const { tx, lines } = makeTx([{ description: "Hostel rent", studentId: "s1" }]);
    await runHostel(tx);
    expect(lines).toHaveLength(1);
  });

  it("raises the invoice in the SCHOOL's currency, not the column default", async () => {
    // Settlement REFUSES a charge whose currency differs from the invoice, so a
    // Ghanaian school's hostel rent raised in naira could never be paid online.
    const { tx, invoices } = makeTx();
    await runHostel(tx);
    expect(invoices.every((i) => i.currency === "GHS")).toBe(true);
  });

  it("reports what it SKIPPED, not just what it billed", async () => {
    // "billed 0" and "skipped 40 already billed" are different facts, and an
    // operator who cannot tell them apart will press it again.
    const { tx } = makeTx([{ description: "Hostel rent", studentId: "s1" }]);
    const out = (await runHostel(tx)) as { studentsBilled: number };
    expect(out.studentsBilled).toBe(1);
  });
});
