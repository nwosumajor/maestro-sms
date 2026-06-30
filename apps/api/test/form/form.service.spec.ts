// =============================================================================
// FormService — required-field validation, one-response, anonymity
// =============================================================================

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { FormService } from "../../src/form/form.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "teach", roles: ["teacher"], permissions: ["form.manage", "form.respond"] };
const student: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["form.respond"] };

const FIELDS = [{ key: "q1", label: "Rate us", type: "rating", required: true }];

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { responseCreate: 0 };
  const tx = {
    form: {
      create: jest.fn().mockResolvedValue({ id: "f1", anonymous: over.anonymous ?? false }),
      findFirst: jest.fn().mockResolvedValue(over.form ?? { id: "f1", title: "S", description: null, fields: FIELDS, audience: "ALL", anonymous: over.anonymous ?? false, status: "OPEN", createdById: "teach", createdAt: new Date() }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "f1", title: "S", description: null, fields: FIELDS, audience: "ALL", anonymous: over.anonymous ?? false, status: "OPEN", createdById: "teach", createdAt: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    formResponse: {
      create: jest.fn(() => { calls.responseCreate++; return Promise.resolve({ id: "r1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.existing ?? null),
      findMany: jest.fn().mockResolvedValue(over.responses ?? [{ id: "r1", respondentId: "stu1", answers: { q1: 5 }, createdAt: new Date() }]),
      count: jest.fn().mockResolvedValue(1),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "teach", name: "Teacher" }), findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Stu" }]) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new FormService(db as never, audit as never);
}

describe("FormService", () => {
  it("rejects a response missing a required field", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).respond(student, "f1", {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts a valid response and records it once", async () => {
    const { tx, calls } = makeTx({ existing: null });
    await svc(tx).respond(student, "f1", { q1: 5 });
    expect(calls.responseCreate).toBe(1);
  });

  it("rejects a second response from the same member", async () => {
    const { tx } = makeTx({ existing: { id: "r0" } });
    await expect(svc(tx).respond(student, "f1", { q1: 5 })).rejects.toThrow(/already responded/i);
  });

  it("hides respondent identity for an ANONYMOUS form", async () => {
    const { tx } = makeTx({ anonymous: true });
    const rows = await svc(tx).responses(staff, "f1");
    expect(rows[0].respondentName).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/stu1|Stu/);
  });

  it("shows respondent identity for a NON-anonymous form", async () => {
    const { tx } = makeTx({ anonymous: false });
    const rows = await svc(tx).responses(staff, "f1");
    expect(rows[0].respondentName).toBe("Stu");
  });

  it("a non-manager cannot read responses", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).responses(student, "f1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
