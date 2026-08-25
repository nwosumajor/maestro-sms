// =============================================================================
// An agent's payout, in two currencies at once
// =============================================================================
// `agent_commission` has carried a `currency` column since the table was
// created, because the commission accrues on the school's FIRST PAID
// subscription and that settles in naira through Paystack or in dollars through
// Stripe. `listAgents` then grouped by `["agentId", "status"]` and dropped it,
// so an agent who introduced one Nigerian school and one American one had kobo
// added to cents.
//
// This is not a display figure. It is what the operator's Growth console shows
// as "accrued" and "paid", and somebody is paid it.
//
// The data was recorded correctly the whole time and the aggregate threw the
// distinction away — the same shape as the fee report, the invoice summary and
// the platform revenue chart, and the exact rule the revenue ledger one
// directory away states in its own header: "money is NEVER summed across
// currencies ... the shape of the answer is what stops the mistake being
// reintroduced".
// =============================================================================

import { GrowthService } from "../../src/billing/growth.service";

function makeService(agents: Array<Record<string, unknown>>, sums: Array<Record<string, unknown>>) {
  const svc = Object.create(GrowthService.prototype) as GrowthService;
  Object.assign(svc, {
    privileged: {
      client: {
        agent: { findMany: jest.fn().mockResolvedValue(agents) },
        agentCommission: { groupBy: jest.fn().mockResolvedValue(sums) },
      },
    },
  });
  return svc;
}

const AGENT = { id: "a1", name: "Ada", code: "ADA", commissionBp: 1_000, active: true };

describe("what an agent is owed", () => {
  it("is reported per currency, never as one number", async () => {
    const svc = makeService(
      [AGENT],
      [
        { agentId: "a1", status: "ACCRUED", currency: "NGN", _sum: { amountMinor: 5_250_000 } },
        { agentId: "a1", status: "ACCRUED", currency: "USD", _sum: { amountMinor: 24_990 } },
        { agentId: "a1", status: "PAID_OUT", currency: "NGN", _sum: { amountMinor: 1_000_000 } },
      ],
    );
    const [row] = await svc.listAgents();
    expect(row.byCurrency).toEqual([
      { currency: "NGN", accruedMinor: 5_250_000, paidOutMinor: 1_000_000 },
      { currency: "USD", accruedMinor: 24_990, paidOutMinor: 0 },
    ]);
    // The figure that used to be there. Nothing in the answer carries it.
    expect(JSON.stringify(row)).not.toContain(String(5_250_000 + 24_990));
  });

  it("gives an agent with no commissions a zero row, not an empty one", async () => {
    // An empty list renders as nothing at all where a zero belongs — the agent
    // exists and is owed nothing, which is a statement, not an absence.
    const svc = makeService([AGENT], []);
    const [row] = await svc.listAgents();
    expect(row.byCurrency).toEqual([{ currency: "NGN", accruedMinor: 0, paidOutMinor: 0 }]);
  });

  it("keeps one agent's commissions out of another's", async () => {
    const svc = makeService(
      [AGENT, { ...AGENT, id: "a2", name: "Bola", code: "BOLA" }],
      [
        { agentId: "a1", status: "ACCRUED", currency: "NGN", _sum: { amountMinor: 100 } },
        { agentId: "a2", status: "ACCRUED", currency: "USD", _sum: { amountMinor: 200 } },
      ],
    );
    const rows = await svc.listAgents();
    expect(rows.map((r) => r.byCurrency)).toEqual([
      [{ currency: "NGN", accruedMinor: 100, paidOutMinor: 0 }],
      [{ currency: "USD", accruedMinor: 200, paidOutMinor: 0 }],
    ]);
  });
});
