/**
 * AN AWARD DECIDED BEFORE THE FEES ARE RAISED.
 *
 * `disburseFeesCredit` posts against the pupil's open invoice. With no open
 * invoice it returned `no_open_invoice`, the award stood, nothing posted and
 * NOTHING EVER RETRIED — measured on the demo tenant, four AWARDED applications
 * totalling NGN 800,000 had credited nobody.
 *
 * That is not an edge case: an award is routinely decided before a term's fees
 * exist. Every other path that moves money against a pupil already handles it —
 * the library, hostel and transport runs CREATE an invoice, and a
 * dedicated-account transfer posts to the CREDIT LEDGER and tells finance to
 * apply it from the next invoice's page. Raising an invoice would be wrong for
 * a scholarship (it is not a charge), so this takes the credit ledger.
 *
 * Driven live end to end before these were written: award -> credit ₦100,000,
 * re-award -> still one entry, revoke -> negative entry and a balance of zero.
 */
import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = stripComments(readFileSync(
  join(__dirname, "..", "..", "src", "scholarship", "scholarship-admin.service.ts"),
  "utf8",
));

function methodBody(signature: string): string {
  const stripped = SRC.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const start = stripped.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // The BODY's brace: walk the parameter parens to their match first.
  let parens = 0;
  let i = stripped.indexOf("(", start);
  for (; i < stripped.length; i++) {
    if (stripped[i] === "(") parens++;
    else if (stripped[i] === ")" && --parens === 0) break;
  }
  let depth = 0;
  i = stripped.indexOf("{", i);
  const from = i;
  for (; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}" && --depth === 0) break;
  }
  const body = stripped.slice(from, i + 1);
  expect(body.length).toBeGreaterThan(120);
  return body;
}

describe("no open invoice is not a dead end", () => {
  it("routes to the credit ledger instead of giving up", () => {
    const body = methodBody("private async disburseFeesCredit(");
    expect(body).toContain("holdAsCredit");
    // The outcome it used to return is gone entirely — a caller cannot be left
    // handling a reason the service no longer produces.
    expect(SRC).not.toContain("no_open_invoice");
  });

  it("writes the credit in the AWARD's currency, never null", () => {
    // Null means "the school's own currency", and an award is denominated by
    // the PLATFORM. They agree only because the guard below requires it.
    const body = methodBody("private async holdAsCredit(");
    expect(body).toContain("currency: AWARD_CURRENCY");
    expect(body).toContain("reason: \"SCHOLARSHIP\"");
  });

  it("refuses rather than writing a credit the family could never spend", () => {
    // A credit is spendable only against an invoice in its own currency, so an
    // NGN credit in a school that bills in cedis is money nobody can use. There
    // is no FX rate here and inventing one would be worse than the gap.
    const body = methodBody("private async holdAsCredit(");
    expect(body).toContain("school_bills_another_currency");
    expect(body).toMatch(/schoolCurrency !== AWARD_CURRENCY/);
  });

  it("is idempotent on the application, like the invoice arm", () => {
    // The award is claimed before this runs, but a crash between the claim and
    // the write would credit a family twice on the retry.
    const body = methodBody("private async holdAsCredit(");
    expect(body).toMatch(/findFirst\([^)]*reference/s);
    expect(body).toContain("if (existing) return");
  });

  it("takes the credit BACK when the award is revoked", () => {
    // The revoke arm reversed a payment and would have left a credit standing:
    // the family keeps a balance for an award the platform withdrew.
    const body = methodBody("async revokeAward(");
    expect(body).toContain("disbursementCreditEntryId");
    expect(body).toContain("SCHOLARSHIP-REVERSAL");
    // A NEGATIVE entry, never a delete — this ledger is append-only in posture.
    expect(body).toContain("deltaMinor: -held.deltaMinor");
  });

  it("clears BOTH links on revoke, or it still reads as disbursed", () => {
    const body = methodBody("async revokeAward(");
    expect(body).toMatch(/disbursementPaymentId: null/);
    expect(body).toMatch(/disbursementCreditEntryId: null/);
  });

  it("tells the family which of the two happened", () => {
    // "Credited against the fees" is only true when a bill actually moved;
    // saying it of a held credit sends a family to check a balance that has
    // not changed.
    // The award lands inside `decide`, which is where the family is notified.
    const body = methodBody("async decide(");
    expect(body).toContain("held as credit");
    expect(body).toContain("credited against the student's school fees");
    // Three outcomes, three sentences — the refusal keeps its own wording.
    expect(body).toContain("the school will apply it to the student's fees");
  });

  it("counts EITHER link as disbursed on the funder's screen", () => {
    // Reading only the payment id was true while an award could reach nowhere
    // else; a credit-held award had moved real money and read "not yet".
    expect(SRC).toMatch(/disbursementPaymentId \|\| r\.disbursementCreditEntryId/);
    expect(SRC).toMatch(/disbursementKind: r\.disbursementPaymentId \? "INVOICE"/);
  });
});

/**
 * AND THE REVOKE IS DRIVEN, not read.
 *
 * A source assertion cannot see a DISABLED branch: `if (false && …)` in front of
 * the reversal left every string it looks for in place and passed all of the
 * above. Mutation testing caught that, and the answer is to run the method — a
 * revoked award that leaves the money on a family's ledger is the sharpest of
 * the failures here, because the funder's screen then reads "not disbursed"
 * while the balance says otherwise.
 */
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

type Row = Record<string, unknown>;

function harness(app: Row, held: Row | null) {
  const created: Row[] = [];
  const updates: Row[] = [];
  const db = {
    scholarshipApplication: {
      findFirst: jest.fn().mockResolvedValue(app),
      updateMany: jest.fn().mockImplementation(({ data }: { data: Row }) => {
        updates.push(data);
        return Promise.resolve({ count: 1 });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    invoice: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    studentCreditEntry: {
      // HONOUR THE WHERE: the reversal guard asks whether a reversal already
      // exists, and a stub answering both lookups the same way is how a deleted
      // idempotency check keeps passing.
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id?: string; reference?: string } }) =>
        Promise.resolve(where.id && held && where.id === held.id ? held : null),
      ),
      create: jest.fn().mockImplementation(({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({ id: "new-entry", ...data });
      }),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, currency: "NGN" }) },
  };
  const svc = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(svc, {
    privileged: { client: db },
    notifications: { enqueue: jest.fn().mockResolvedValue(undefined) },
    db: { runAsTenant: jest.fn().mockResolvedValue([]) },
    audit: { record: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    auditOwn: jest.fn().mockResolvedValue(undefined),
    notifyFamily: jest.fn().mockResolvedValue(undefined),
    listApplicationById: jest.fn().mockResolvedValue([{ id: "a-1" }]),
  });
  return { svc, db, created, updates };
}

const P = { userId: "owner-1", schoolId: "platform-1", roles: ["super_admin"], permissions: [] } as never;

describe("revoking an award held as credit", () => {
  const app = {
    id: "a-1",
    status: "AWARDED",
    schoolId: "school-1",
    studentId: "kid-1",
    disbursementPaymentId: null,
    disbursementCreditEntryId: "entry-1",
  };
  const held = { id: "entry-1", deltaMinor: 10_000_00, currency: "NGN" };

  it("posts a NEGATIVE entry that cancels the credit", async () => {
    const { svc, created } = harness(app, held);
    await svc.revokeAward(P, "a-1", "Withdrawn.");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      deltaMinor: -held.deltaMinor,
      currency: "NGN",
      reason: "REFUNDED",
      reference: "SCHOLARSHIP-REVERSAL:a-1",
    });
  });

  it("nets the family's balance back to nothing", async () => {
    const { svc, created } = harness(app, held);
    await svc.revokeAward(P, "a-1", "Withdrawn.");
    expect(held.deltaMinor + Number(created[0].deltaMinor)).toBe(0);
  });

  it("clears the credit link, so the funder's screen stops reading disbursed", async () => {
    const { svc, updates } = harness(app, held);
    await svc.revokeAward(P, "a-1", "Withdrawn.");
    expect(updates[0]).toMatchObject({ disbursementPaymentId: null, disbursementCreditEntryId: null });
  });

  it("does not double-reverse when one is already on the ledger", async () => {
    const { svc, db, created } = harness(app, held);
    db.studentCreditEntry.findFirst = jest
      .fn()
      .mockImplementation(({ where }: { where: { id?: string; reference?: string } }) =>
        Promise.resolve(where.id ? held : { id: "already", deltaMinor: -held.deltaMinor }),
      );
    await svc.revokeAward(P, "a-1", "Withdrawn.");
    expect(created).toHaveLength(0);
  });

  it("writes nothing when the award never reached the ledger at all", async () => {
    const { svc, created } = harness({ ...app, disbursementCreditEntryId: null }, null);
    await svc.revokeAward(P, "a-1", "Withdrawn.");
    expect(created).toHaveLength(0);
  });
});
