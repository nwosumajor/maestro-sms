// =============================================================================
// One award, two credits
// =============================================================================
// Awarding a scholarship posts a SCHOLARSHIP payment against the pupil's own
// fee invoice. `decide` guarded it with a READ — "is the status already
// AWARDED" — and then, in no transaction at all, created the payment and
// separately updated the application.
//
// Two ways that pays twice, and only one of them needs concurrency:
//
//   RACE          two awards both pass the status read before either writes,
//                 both disburse. The same read-then-write shape already
//                 hardened on a library return and on every workflow
//                 transition — but here on the path that moves money onto a
//                 child's fee account.
//
//   CRASH         the payment is written, then the process dies before the
//                 application records it. The row still reads QUALIFIED, so the
//                 next award credits the family AGAIN. No concurrency at all.
//
// REPRODUCED against the running system for the crash case: award once, reset
// the row to the state a mid-award failure leaves, award again — two POSTED
// payments with the IDENTICAL reference SCHOLARSHIP:<applicationId>, 500000
// each, 1,000,000 credited against a single 500,000 award.
//
// The reference already identified the award uniquely. Nothing looked at it —
// though `billFine`, a few files away, makes exactly this check for exactly this
// reason.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const APP = "app-1";
const REF = `SCHOLARSHIP:${APP}`;

function make(opts: { existingPayments?: Array<Record<string, unknown>>; claimCount?: number } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: "inv-1", totalMinor: 1_000_000, payments: opts.existingPayments ?? [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: `pay-${created.length}`, ...data });
      }),
    },
    scholarshipApplication: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
    },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, { privileged: { client: db }, notifications: {}, audit: { record: jest.fn() } });
  const disburse = (s as unknown as {
    disburseFeesCredit: (d: unknown, sc: string, st: string, a: number, id: string, by: string) => Promise<unknown>;
  }).disburseFeesCredit.bind(s);
  return { s, db, created, disburse };
}

describe("disbursing an award", () => {
  it("credits the invoice once", async () => {
    const { db, created, disburse } = make();
    const out = await disburse(db, "school-1", "pupil-1", 500_000, APP, "owner-1");
    expect(created).toHaveLength(1);
    expect(out).toMatchObject({ amountMinor: 500_000 });
    expect(created[0].reference).toBe(REF);
  });

  it("does NOT credit a second time when the award already posted", async () => {
    // The crash case, reproduced live before this existed.
    const { db, created, disburse } = make({
      existingPayments: [{ id: "pay-old", reference: REF, status: "POSTED", amountMinor: 500_000, kind: "SCHOLARSHIP" }],
    });
    const out = await disburse(db, "school-1", "pupil-1", 500_000, APP, "owner-1");
    expect(created).toHaveLength(0);
    // Returns the payment that already exists, so the application still records
    // which one paid it rather than losing the link.
    expect(out).toEqual({ paymentId: "pay-old", amountMinor: 500_000 });
  });

  it("is not fooled by a REVERSED payment carrying the same reference", async () => {
    // Only a POSTED credit counts as already-paid. A reversed one means the
    // money came back, and the award should be able to pay again.
    const { db, created, disburse } = make({
      existingPayments: [{ id: "pay-old", reference: REF, status: "REVERSED", amountMinor: 500_000 }],
    });
    await disburse(db, "school-1", "pupil-1", 500_000, APP, "owner-1");
    expect(created).toHaveLength(1);
  });

  it("caps the credit at what is still owed", async () => {
    const { db, created, disburse } = make({
      existingPayments: [{ id: "p1", reference: "OTHER", status: "POSTED", amountMinor: 900_000, kind: "PAYMENT" }],
    });
    await disburse(db, "school-1", "pupil-1", 500_000, APP, "owner-1");
    expect(created[0].amountMinor).toBe(100_000); // 1,000,000 total less 900,000 paid
  });

  it("counts a refund as money returned, not money paid", async () => {
    const { db, created, disburse } = make({
      existingPayments: [
        { id: "p1", reference: "OTHER", status: "POSTED", amountMinor: 900_000, kind: "PAYMENT" },
        { id: "p2", reference: "OTHER", status: "POSTED", amountMinor: 400_000, kind: "REFUND" },
      ],
    });
    await disburse(db, "school-1", "pupil-1", 500_000, APP, "owner-1");
    // 900,000 paid less a 400,000 refund leaves 500,000 owed of 1,000,000.
    expect(created[0].amountMinor).toBe(500_000);
  });
});

describe("the award is claimed before anything is spent", () => {
  it("serialises on a conditional update, not on a read", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/scholarship/scholarship-admin.service.ts"),
      "utf8",
    ) as string;
    const decide = src.slice(src.indexOf("async decide("), src.indexOf("async announceExam("));
    expect(decide).toMatch(/updateMany\(\{\s*where: \{ id, status: \{ notIn: \["AWARDED", "REJECTED"\] \} \}/);
    expect(decide).toMatch(/if \(claimed\.count === 0\) throw new BadRequestException/);
    // And the claim comes BEFORE the money moves, or it serialises nothing.
    expect(decide.indexOf("claimed.count === 0")).toBeLessThan(decide.indexOf("disburseFeesCredit("));
  });
});

// -----------------------------------------------------------------------------
// Best Three is an invariant across DIFFERENT applications, which a per-row
// claim cannot hold. The position check reads every already-awarded row for the
// programme; two awards for two candidates at the same position can both pass it.
//
// It did NOT reproduce over HTTP — two simultaneous awards at position 1, then
// three at position 2, were each correctly refused. The window is narrow. That
// is a reason to close it cheaply rather than to call it safe, which is the
// verdict this repo already reached on the library-return race it hardened
// anyway; here the consequence is money and a promise to a family about where
// their child placed.
// -----------------------------------------------------------------------------
describe("one award per position, per programme", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/scholarship/scholarship-admin.service.ts"),
    "utf8",
  ) as string;

  it("is held by the DATABASE, not only by a read", () => {
    const sql = require("node:fs").readFileSync(
      require("node:path").join(
        __dirname,
        "../../../../packages/db/prisma/migrations/20261227000000_scholarship_award_position_unique/migration.sql",
      ),
      "utf8",
    ) as string;
    expect(sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(sql).toMatch(/\("programId", "awardPosition"\)/);
    // PARTIAL: awardPosition means nothing on a rejected row, and a plain unique
    // index would collide across them.
    expect(sql).toMatch(/WHERE status = 'AWARDED'/);
  });

  it("turns the database's refusal into the sentence a person can act on", () => {
    // Unhandled, a constraint violation is a 500 — which reads as a broken
    // platform rather than "somebody just took that position".
    const decide = src.slice(src.indexOf("async decide("), src.indexOf("async announceExam("));
    expect(decide).toMatch(/code === "P2002"/);
    expect(decide).toMatch(/position has already been awarded/);
    // And only P2002: anything else must keep its own failure.
    expect(decide).toMatch(/throw e;/);
  });
});
