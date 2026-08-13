// =============================================================================
// What a leaver owes, and what the school releases
// =============================================================================
// Schools commonly hold a transcript or a leaving certificate until the family
// has settled what they owe. The platform had nowhere to record that decision,
// so it lived in somebody's head or nowhere at all.
//
// THE LINE THIS DRAWS, and it is a legal one rather than a preference: the gate
// covers ACADEMIC artefacts — transcript, report card, certificate. It does NOT
// cover the data-protection export. A data subject's right to their own personal
// data is not a debt-collection lever, and withholding it over money is unlawful
// rather than merely firm.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDocumentsReleasable } from "../../src/lms/leaver-documents";

const STUDENT = "22222222-2222-2222-2222-222222222222";
const tx = (user: Record<string, unknown> | null) =>
  ({ user: { findFirst: jest.fn().mockResolvedValue(user) } }) as never;

describe("the gate on a leaver's documents", () => {
  it("refuses a leaver whose documents are withheld", async () => {
    await expect(
      assertDocumentsReleasable(tx({ status: "EXITED", docsReleasedAt: null, name: "Ada Obi" }), STUDENT),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("names the person and says WHO can release it", async () => {
    // An error that only says "forbidden" sends a bursar to support. This has to
    // tell them the next step.
    await expect(
      assertDocumentsReleasable(tx({ status: "EXITED", docsReleasedAt: null, name: "Ada Obi" }), STUDENT),
    ).rejects.toThrow(/Ada Obi[\s\S]*principal releases them from the leavers page/);
  });

  it("allows it once the principal has released them", async () => {
    await expect(
      assertDocumentsReleasable(
        tx({ status: "EXITED", docsReleasedAt: new Date(), name: "Ada Obi" }),
        STUDENT,
      ),
    ).resolves.toBeUndefined();
  });

  it("NEVER gates a pupil who is still at the school", async () => {
    // The failure that would matter most in practice: every report card, every
    // term, for everybody. Gating is only ever about leavers.
    await expect(
      assertDocumentsReleasable(tx({ status: "ACTIVE", docsReleasedAt: null, name: "Ada Obi" }), STUDENT),
    ).resolves.toBeUndefined();
  });

  it("does not gate somebody it cannot find", async () => {
    // Callers do their own 404 scoping; this must not become a second, quieter
    // existence check with a different answer.
    await expect(assertDocumentsReleasable(tx(null), STUDENT)).resolves.toBeUndefined();
  });
});

describe("which documents are gated", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

  it("the report card is", () => {
    expect(read("reportcards/reportcard.service.ts")).toMatch(/assertDocumentsReleasable\(tx, studentId\)/);
  });

  it("the certificate is", () => {
    expect(read("certificate/certificate.service.ts")).toMatch(/assertDocumentsReleasable\(tx, input\.subjectId\)/);
  });

  it("the DATA-PROTECTION EXPORT is NOT — and that is the point", () => {
    // Deliberate and load-bearing. A right of access is not conditional on a
    // debt; making it so would be unlawful. If this ever starts matching, the
    // change was almost certainly a mistake.
    expect(read("privacy/privacy.service.ts")).not.toMatch(/assertDocumentsReleasable/);
  });
});

describe("recording the decision", () => {
  const src = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
  const method = src.slice(src.indexOf("async setDocumentRelease"), src.indexOf("async listExited"));

  it("only ever applies to somebody who has LEFT", () => {
    expect(method).toMatch(/where: \{ id: studentId, status: "EXITED" \}/);
  });

  it("is reversible in both directions", () => {
    // A release given on a promise that is not kept has to be retractable, and
    // one withheld in error has to be grantable without a committee.
    expect(method).toMatch(/docsReleasedAt: new Date\(\), docsReleasedById: p\.userId/);
    expect(method).toMatch(/docsReleasedAt: null, docsReleasedById: null/);
  });

  it("records WHO released them, not just that somebody did", () => {
    expect(method).toMatch(/docsReleasedById: p\.userId/);
  });

  it("audits both directions distinctly", () => {
    expect(method).toMatch(/student\.documents\.released/);
    expect(method).toMatch(/student\.documents\.withheld/);
  });

  it("404s anyone who is not a leaver of this school", () => {
    expect(method).toMatch(/changed\.count === 0.*NotFoundException|if \(changed\.count === 0\) throw new NotFoundException/s);
  });
});

describe("the debt shown on the leavers page", () => {
  const src = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
  const list = src.slice(src.indexOf("async listExited"));

  it("is never negative — an overpayment is a credit, not a debt", () => {
    // "Owes -5,000" on a leavers page is how a bursar chases somebody who owes
    // nothing.
    expect(list).toMatch(/Math\.max\(0, owedBy\.get\(r\.id\) \?\? 0\)/);
  });

  it("counts only billable invoices", () => {
    // DRAFT is not owed yet and CANCELLED never was.
    expect(list).toMatch(/status: \{ in: \["ISSUED", "PARTIALLY_PAID"\] \}/);
  });

  it("is grouped for the whole page, not queried per row", () => {
    // A leavers list only grows. Two queries per row is the shape that turns a
    // fast page into a slow one three years in.
    expect(list).toMatch(/groupBy/);
    expect(list).not.toMatch(/for \(const r of rows[\s\S]{0,200}?await tx\./);
  });
});
