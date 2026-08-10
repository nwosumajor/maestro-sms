// =============================================================================
// Message credits — reconciliation, and the checkpoint that must not lie
// =============================================================================
// The platform is billed by the messaging provider PER MESSAGE and charges the
// school PER CREDIT. Nothing compared those counts, and nothing could: the
// Twilio adapter returned `{ ok: true }` and discarded the message SID, so no
// debit was tied to a real send.
//
// Two directions of loss, and only one of them is visible to anybody:
//   * a debit the provider never heard of — a school charged for nothing
//   * a message the provider sent with no debit — the PLATFORM paying for a
//     message it never charged for, which nobody notices
//
// The checkpoint cases are about the balance staying honest while being fast:
// a checkpoint must record the balance without changing it, and must be
// recomputed from the WHOLE ledger so drift cannot compound.
// =============================================================================

import { MessageCreditReconciliationService } from "../../src/notifications/message-credit-reconciliation.service";

const SCHOOL_A = "aaaaaaaa-0000-0000-0000-000000000000";

function makeSweep(opts: {
  ledger?: Array<{ schoolId: string; sum: number }>;
  debits?: Array<{ providerRef: string | null }>;
  sent?: Array<{ providerRef: string }> | null;
  noClient?: boolean;
  canList?: boolean;
}) {
  const created: Array<Record<string, unknown>> = [];
  const groupBy = jest.fn().mockResolvedValue(
    (opts.ledger ?? [{ schoolId: SCHOOL_A, sum: 40 }]).map((l) => ({
      schoolId: l.schoolId,
      _sum: { deltaCredits: l.sum },
    })),
  );
  const client = {
    messageCreditEntry: {
      groupBy,
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return a.data;
      }),
      findMany: jest.fn().mockResolvedValue(
        (opts.debits ?? []).map((d, i) => ({ id: `d${i}`, schoolId: SCHOOL_A, providerRef: d.providerRef })),
      ),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "owner", schoolId: "platform" }]) },
  };
  const enqueue = jest.fn().mockResolvedValue({});
  const provider: Record<string, unknown> = {};
  if (opts.canList !== false) {
    provider.listRecentMessages = jest.fn().mockResolvedValue(opts.sent ?? []);
  }
  const svc = Object.create(MessageCreditReconciliationService.prototype) as MessageCreditReconciliationService;
  Object.assign(svc, {
    logger: { log: jest.fn(), warn: jest.fn() },
    db: { client: opts.noClient ? null : client },
    notifications: { enqueue },
    provider,
  });
  return { svc, created, enqueue, groupBy };
}

describe("credit reconciliation", () => {
  afterEach(() => jest.restoreAllMocks());

  it("flags a debit the provider has never heard of — a school charged for nothing", async () => {
    const { svc, enqueue } = makeSweep({
      debits: [{ providerRef: "SM_real" }, { providerRef: "SM_ghost" }],
      sent: [{ providerRef: "SM_real" }],
    });
    const r = await svc.sweep("MANUAL");
    expect(r.unknownToProvider).toBe(1);
    expect(enqueue).toHaveBeenCalled();
  });

  it("flags a message the provider SENT with no debit — the platform's own loss", async () => {
    // The direction nobody notices: we paid the provider and charged nobody.
    const { svc, enqueue } = makeSweep({
      debits: [{ providerRef: "SM_a" }],
      sent: [{ providerRef: "SM_a" }, { providerRef: "SM_b" }],
    });
    const r = await svc.sweep("MANUAL");
    expect(r.uncharged).toBe(1);
    expect(enqueue.mock.calls[0][1].body).toMatch(/platform paid/i);
  });

  it("counts UNLINKED debits rather than treating them as reconciled", async () => {
    // Every send made before providerRef existed lands here. Silently ignoring
    // them would report a clean sweep over a ledger nothing had verified.
    const { svc } = makeSweep({
      debits: [{ providerRef: null }, { providerRef: null }, { providerRef: "SM_a" }],
      sent: [{ providerRef: "SM_a" }],
    });
    const r = await svc.sweep("MANUAL");
    expect(r.unlinked).toBe(2);
    expect(r.unknownToProvider).toBe(0);
  });

  it("stays silent when everything matches", async () => {
    const { svc, enqueue } = makeSweep({
      debits: [{ providerRef: "SM_a" }],
      sent: [{ providerRef: "SM_a" }],
    });
    const r = await svc.sweep("MANUAL");
    expect({ unknown: r.unknownToProvider, uncharged: r.uncharged }).toEqual({ unknown: 0, uncharged: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a sweep that could NOT run is not a clean bill of health", async () => {
    const { svc } = makeSweep({ noClient: true });
    expect(await svc.sweep("MANUAL")).toMatchObject({ skipped: "NO_DB", checkpointed: 0 });
  });

  it("says so when the provider cannot list, rather than reporting reconciled", async () => {
    const { svc } = makeSweep({ canList: false });
    const r = await svc.sweep("MANUAL");
    expect(r.skipped).toBe("NO_PROVIDER");
    // Checkpoints still happen — the performance half does not depend on the
    // provider being able to answer.
    expect(r.checkpointed).toBe(1);
  });
});

describe("the checkpoint", () => {
  afterEach(() => jest.restoreAllMocks());

  it("RECORDS the balance without changing it", async () => {
    // deltaCredits MUST be 0. Anything else and balance = SUM(ledger) — the
    // invariant the whole design rests on — stops being true.
    const { svc, created } = makeSweep({ ledger: [{ schoolId: SCHOOL_A, sum: 137 }] });
    await svc.sweep("MANUAL");
    expect(created[0]).toMatchObject({ reason: "CHECKPOINT", deltaCredits: 0, balanceAfter: 137 });
  });

  it("is recomputed from the WHOLE ledger, never from the previous checkpoint", async () => {
    // A checkpoint derived from a checkpoint would inherit drift for ever.
    // Recomputing makes any drift self-healing: it can only exist between runs.
    const { svc, groupBy } = makeSweep({ ledger: [{ schoolId: SCHOOL_A, sum: 40 }] });
    await svc.sweep("MANUAL");
    const args = groupBy.mock.calls[0][0] as Record<string, unknown>;
    expect(args.by).toEqual(["schoolId"]);
    // No date floor and no reason filter: it sums everything.
    expect(args.where).toBeUndefined();
  });

  it("one school's failure does not stop the others being checkpointed", async () => {
    const { svc } = makeSweep({
      ledger: [
        { schoolId: SCHOOL_A, sum: 10 },
        { schoolId: "bbbbbbbb-0000-0000-0000-000000000000", sum: 20 },
      ],
    });
    const s = svc as unknown as { db: { client: { messageCreditEntry: { create: jest.Mock } } } };
    s.db.client.messageCreditEntry.create.mockRejectedValueOnce(new Error("boom"));
    const r = await svc.sweep("MANUAL");
    expect(r.checkpointed).toBe(1);
  });
});
