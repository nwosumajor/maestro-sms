// =============================================================================
// The most-opened read of a minor's record wrote no audit row
// =============================================================================
// Applied the lesson from #253 — when a control is copied per module, ask which
// module is MISSING it — to the control Golden Rule #5 depends on: "all
// reads/writes to student PII are audit-logged".
//
// A sweep of every method touching `studentProfile`/`medicalRecord`/`contact`
// returned 13, of which 7 looked unaudited. SIX were my heuristic being wrong,
// and it is worth recording why so the next sweep is not re-run blind:
//
//   operator.listSchoolStudents  audits via `auditAsOperator` AFTER the tx —
//                                a differently-named helper, outside the body
//                                the sweep read.
//   privacy archive.assemble     a PRIVATE helper; its caller `create()` audits.
//   sis.requireProfile           selects `id` only — an existence check, no PII.
//   sis.profileReviewQueue       selects ids and timestamps, no PII.
//   sis.completion               reads the profile but returns only WHICH
//                                fields are blank, never their values.
//   platform-analytics.overview  counts.
//
// The seventh was real, and it was the central one: `getProfile` returns a
// minor's date of birth, gender, telephone number, personal email, home address
// and admission number, and logged nothing. It is what the pupil record page
// loads, so it is the most-opened PII read in the product.
//
// The asymmetry is what gave it away — `getMedical` audits, `listGuardians`
// audits, and the profile between them did not. Verified against the running
// system BEFORE the fix: opening a pupil produced exactly one audit row,
//
//     sis.medical.read | medical_record | 0f0a8188-…
//
// and nothing for the profile. "Who looked at this child's record" could be
// answered for their allergies and not for their home address.
//
// AND A SECOND ONE, in code I wrote in an earlier phase: `listGuardians` logged
// AFTER an early `return []`, so the same click was recorded for a pupil with
// guardians and silently not for a pupil without.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "S",
  userId: "u-admin",
  roles: ["school_admin"],
  permissions: ["student.profile.read", "student.medical.read"],
};

function makeService(opts: { profile?: Record<string, unknown> | null; guardians?: string[] } = {}) {
  const audits: Array<{ action: string; entity: string; entityId: string; metadata?: unknown }> = [];
  const tx = {
    studentProfile: {
      findFirst: jest.fn(async () =>
        opts.profile === undefined
          ? { id: "sp-1", studentId: "s-1", dateOfBirth: new Date(), phone: "0800", addressLine1: "12 Main St" }
          : opts.profile,
      ),
    },
    parentChild: {
      findMany: jest.fn(async () => (opts.guardians ?? []).map((parentId) => ({ parentId }))),
    },
    user: {
      findMany: jest.fn(async () =>
        (opts.guardians ?? []).map((id) => ({
          id,
          name: "A Guardian",
          email: "g@example.com",
          contactEmail: "g@example.com",
          phone: null,
          loginEmailGenerated: false,
        })),
      ),
      findFirst: jest.fn(async () => ({ id: "s-1", name: "A Pupil" })),
    },
    enrollment: { findFirst: jest.fn(async () => ({ id: "e-1" })), findMany: jest.fn(async () => []) },
    // One definition of who teaches a class (common/teaches.ts) reads the
    // class SUPERVISOR and the subject offerings too — every real TenantTx
    // answers all three.
    class: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new SisService(
    db as never,
    {
      record: jest.fn(async (e: { action: string; entity: string; entityId: string; metadata?: unknown }) => {
        audits.push(e);
      }),
    } as never,
    { encrypt: (v: string) => v, decrypt: (v: string) => v } as never,
  );
  return { svc, audits };
}

describe("reading a pupil's SIS profile", () => {
  it("writes an audit row", async () => {
    const { svc, audits } = makeService();
    await svc.getProfile(staff, "s-1");
    const entry = audits.find((a) => a.action === "sis.profile.read");
    expect(entry).toBeDefined();
  });

  it("names the pupil, so the log answers 'who looked at THIS child'", async () => {
    const { svc, audits } = makeService();
    await svc.getProfile(staff, "s-1");
    expect(audits.find((a) => a.action === "sis.profile.read")!.entityId).toBe("s-1");
  });

  it("does not log a read that did not happen", async () => {
    // A missing profile is a 404, not an access to a record.
    const { svc, audits } = makeService({ profile: null });
    await expect(svc.getProfile(staff, "s-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(audits.filter((a) => a.action === "sis.profile.read")).toEqual([]);
  });
});

describe("reading who a pupil's guardians are", () => {
  it("is audited when there are guardians", async () => {
    const { svc, audits } = makeService({ guardians: ["p-1"] });
    await svc.listGuardians(staff, "s-1");
    expect(audits.some((a) => a.action === "sis.guardians.read")).toBe(true);
  });

  it("is audited when there are NONE — the access still happened", async () => {
    // The bug: the log sat after an early `return []`, so the same click was
    // recorded for a pupil with guardians and silently not for one without.
    // The audit answers a question about the ACCESS, not about what it found.
    const { svc, audits } = makeService({ guardians: [] });
    await svc.listGuardians(staff, "s-1");
    const entry = audits.find((a) => a.action === "sis.guardians.read");
    expect(entry).toBeDefined();
    expect(entry!.metadata).toEqual({ guardians: 0 });
  });
});

describe("the sibling reads that were already right", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/sis/sis.service.ts"),
    "utf8",
  ) as string;

  it.each([
    ["getProfile", "sis.profile.read"],
    ["getMedical", "sis.medical.read"],
    ["listGuardians", "sis.guardians.read"],
  ])("%s logs %s", (fn, action) => {
    const at = SRC.search(new RegExp(`async ${fn}\\s*\\(`));
    expect(at).toBeGreaterThan(-1);
    // Within the method — the next `async ` declaration bounds it.
    const next = SRC.slice(at + 10).search(/\n  (?:private |public )?async /);
    const body = SRC.slice(at, next === -1 ? undefined : at + 10 + next);
    expect([fn, body.includes(action)]).toEqual([fn, true]);
  });

  it("keeps the three of them consistent, which is how this was found", () => {
    // One read of a minor's record audited and its neighbour not is the tell.
    // If a fourth is added here, it should look like these.
    const reads = (SRC.match(/sis\.(profile|medical|guardians)\.read/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
