// =============================================================================
// Six deliveries of one webhook, six payments, one invoice marked PAID
// =============================================================================
// `InvoiceSettlementService.applyOnlinePayment` is THE posting path — card,
// mobile money, dedicated NUBAN, verify-on-return and the reconciliation sweep
// all funnel through it — and it is documented as "idempotent on the gateway
// reference". It guarded with:
//
//     const already = await tx.payment.findFirst({ where: { invoiceId, reference } });
//     if (already) return "duplicate";
//     await tx.payment.create({ ... });
//
// Read-then-write, at the READ COMMITTED this repo runs by default. SEQUENTIAL
// replay was idempotent, which is exactly why it survived: the check is real
// and simply does not survive being raced.
//
// Measured live against the running stack — six simultaneous deliveries of ONE
// signed Paystack event, the same reference on all six:
//
//     invoice                     5,000,000 minor, status PAID
//     payments created            6
//     posted                      30,000,000 minor
//     distinct gateway references 1
//
// A parent pays once and the ledger records it six times. A gateway retries a
// slow response, so overlapping delivery is ordinary rather than exotic — and
// the guard's own comment already said the gateway "can double-deliver" and
// that verify-on-return "can race the webhook".
//
// FIX: `@@unique([invoiceId, reference])`, and P2002 converted to the SAME
// "duplicate" the guard returns — a race that answered differently would be
// observable, and a 409 would make the gateway retry it again.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SCHEMA = readFileSync(
  join(__dirname, "../../../../packages/db/prisma/schema/fees.prisma"),
  "utf8",
);
const SETTLEMENT = stripComments(
  readFileSync(join(__dirname, "../../src/fees/settlement.service.ts"), "utf8"),
);

/** The Payment model's own block — a repo-wide grep would match four models. */
function paymentModel(): string {
  const i = SCHEMA.indexOf("model Payment ");
  expect(i).toBeGreaterThan(-1);
  return SCHEMA.slice(i, SCHEMA.indexOf("\n}", i));
}

describe("one gateway charge posts once", () => {
  it("the DATABASE enforces it, not just a read-then-write check", () => {
    // The property: a uniqueness constraint on the pair the guard tests. At
    // READ COMMITTED nothing else can stop two concurrent inserts.
    expect(paymentModel()).toMatch(/@@unique\(\[invoiceId,\s*reference\]\)/);
  });

  it("ships a migration, so an existing database gets the constraint too", () => {
    // A schema change with no migration is a constraint only fresh databases
    // have — and this one is about money already flowing.
    const dir = join(__dirname, "../../../../packages/db/prisma/migrations");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const hit = readdirSync(dir).filter((d) => d.includes("payment_reference_unique"));
    expect(hit.length).toBe(1);
    const sql = readFileSync(join(dir, hit[0], "migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/"invoiceId",\s*"reference"/);
  });

  it("answers the RACE with the same outcome as the guard", () => {
    // If the losing insert threw, the race would be observable: the gateway
    // would see a 500/409 and retry the charge it had already delivered.
    expect(SETTLEMENT).toMatch(/P2002/);
    const near = SETTLEMENT.slice(SETTLEMENT.indexOf("P2002") - 200, SETTLEMENT.indexOf("P2002") + 200);
    expect(near).toMatch(/return "duplicate"/);
  });

  it("keeps the cheap check, so the common case costs no failed insert", () => {
    // The findFirst is not redundant: almost every retry is sequential, and
    // letting those reach a constraint violation would fill the log with
    // errors for an outcome that is entirely expected.
    expect(SETTLEMENT).toMatch(/findFirst\(\{[\s\S]{0,120}reference: input\.reference/);
  });

  it("does NOT constrain manual payments that carry no reference", () => {
    // Postgres treats NULLs as distinct, so a school recording cash with no
    // gateway reference is unaffected — 7 of the 20 payments on the demo
    // database are exactly that. The constraint is on the PAIR, so a bank slip
    // covering two invoices also still posts twice.
    expect(paymentModel()).toMatch(/reference\s+String\?/);
  });
});
