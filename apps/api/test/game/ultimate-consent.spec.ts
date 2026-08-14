// =============================================================================
// "Guardian consent" that involved no guardian
// =============================================================================
// Entering the cross-school arena needs two consents: the school opts in, then
// each pupil has "per-student guardian consent". The second recorded only
// `grantedById` — the school_admin who ticked a checkbox labelled "Guardian
// consent granted". No guardian appeared in the row, the schema, or the request.
//
// So a school could assert a parent's decision about their child with nothing
// behind it, on the one surface where a minor's handle and school name leave the
// tenant and appear on other schools' leaderboards.
//
// The same platform already holds the stricter line elsewhere, and for a smaller
// decision: scholarship consent verifies a `parentChild` link and refuses with
// "Only a guardian of this student can give consent" — money, to the family,
// inside their own school. Two standards for the same children was the part that
// could not be defended.
//
// The fix keeps staff as the RECORDER — schools collect these on paper and that
// is legitimate — and requires them to name the guardian, verified to really be
// a guardian of that pupil. An assertion becomes evidence.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { UltimateService } from "../../src/game/ultimate.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "school-A";
const admin: Principal = {
  schoolId: SCHOOL,
  userId: "admin-1",
  roles: ["school_admin"],
  permissions: ["game.ultimate.consent"],
};

function makeService(opts: { studentExists?: boolean; guardianLink?: boolean } = {}) {
  const { studentExists = true, guardianLink = true } = opts;
  const consentCreate = jest.fn().mockResolvedValue({ id: "c-1" });
  const consentUpdate = jest.fn().mockResolvedValue({ id: "c-1" });
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue(studentExists ? { id: "pupil-1" } : null) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(guardianLink ? { id: "link-1" } : null) },
    ultimateConsent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: consentCreate,
      update: consentUpdate,
    },
    auditLog: { create: auditCreate },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new UltimateService(db as never, { record: auditCreate } as never, { emit: jest.fn() } as never);
  return { service, tx, consentCreate, auditCreate };
}

describe("granting consent", () => {
  it("refuses without a named guardian", async () => {
    const { service, consentCreate } = makeService();
    await expect(
      service.setConsent(admin, { studentId: "pupil-1", granted: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // And writes NOTHING — a refused grant must not leave a half-record.
    expect(consentCreate).not.toHaveBeenCalled();
  });

  it("refuses a person who is not a guardian of THIS pupil", async () => {
    // The check the scholarship flow already makes. Without it, naming anyone at
    // all would satisfy the requirement and change nothing.
    const { service, consentCreate } = makeService({ guardianLink: false });
    await expect(
      service.setConsent(admin, { studentId: "pupil-1", granted: true, guardianId: "someone-else" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(consentCreate).not.toHaveBeenCalled();
  });

  it("records BOTH the recorder and the guardian", async () => {
    const { service, consentCreate } = makeService();
    await service.setConsent(admin, { studentId: "pupil-1", granted: true, guardianId: "mum-1" });
    expect(consentCreate.mock.calls[0][0].data).toMatchObject({
      granted: true,
      grantedById: "admin-1", // who wrote it down
      guardianId: "mum-1", // whose decision it is
    });
  });

  it("checks the pupil exists before anything else", async () => {
    const { service } = makeService({ studentExists: false });
    await expect(
      service.setConsent(admin, { studentId: "ghost", granted: true, guardianId: "mum-1" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("revoking consent", () => {
  it("needs no guardian named", async () => {
    // Withdrawing protection must never be harder than granting it. A parent who
    // changes their mind cannot be blocked because nobody can be reached.
    const { service, consentCreate } = makeService({ guardianLink: false });
    await expect(
      service.setConsent(admin, { studentId: "pupil-1", granted: false }),
    ).resolves.toEqual({ studentId: "pupil-1", granted: false });
    expect(consentCreate.mock.calls[0][0].data).toMatchObject({ granted: false, guardianId: null });
  });
});

describe("the record", () => {
  const SRC = readFileSync(join(__dirname, "../../src/game/ultimate.service.ts"), "utf8");

  it("puts the guardian on the audit entry too", () => {
    // The consent row holds the CURRENT state; the audit holds who said so and
    // when it changed. A later dispute needs the second one.
    expect(SRC).toMatch(/"ultimate\.consent\.set", input\.studentId, \{\s*granted: input\.granted,\s*guardianId,/);
  });

  it("the guardian column is nullable, for rows written before this", () => {
    const schema = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/schema/ultimate.prisma"),
      "utf8",
    );
    // Inventing a guardian for historical rows would be worse than admitting
    // there was none.
    expect(schema).toMatch(/guardianId\s+String\?\s+@db\.Uuid/);
  });
});
