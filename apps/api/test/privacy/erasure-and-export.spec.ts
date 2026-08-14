// =============================================================================
// An erasure that reported success it could not know it had
// =============================================================================
// Approving a right-to-erasure request nulls the file keys in the transaction,
// then deletes the bytes from object storage afterwards. That second step was:
//
//     await this.storage.delete(key).catch(() => undefined);
//
// A swallowed failure, on the one operation whose entire purpose is that
// something ceases to exist. And it is worse than a normal lost delete, because
// the pointer is already gone: the row's `fileKey` was nulled in the committed
// transaction, so a file left behind in storage is orphaned, unfindable and
// unerasable — while the request reads APPROVED and the audit says the files
// were erased. Asked by a regulator whether the data was destroyed, the school's
// own evidence would have said yes.
//
// The DECISION stays APPROVED: it was made, and correctly. What changes is that
// incomplete EXECUTION is written down, with the keys, in the append-only log,
// so the objects can still be found and purged by hand.
//
// The ordering is kept (null, commit, then delete) deliberately. Deleting before
// the transaction commits would destroy bytes for a decision that might roll
// back; a dangling pointer to an already-deleted object is recoverable, and
// orphaned PII is not.
// =============================================================================

import { PrivacyService } from "../../src/privacy/privacy.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const controller: Principal = {
  schoolId: "school-A",
  userId: "dpo-1",
  roles: ["school_admin"],
  permissions: ["privacy.erasure.review"],
};

function makeService(opts: { failKeys?: string[] } = {}) {
  const { failKeys = [] } = opts;
  const audited: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const tx = {
    erasureRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: "req-1", status: "PENDING", studentId: "pupil-1" }),
      update: jest.fn().mockResolvedValue({ id: "req-1", status: "APPROVED" }),
    },
    submission: {
      findMany: jest.fn().mockResolvedValue([
        { id: "s-1", fileKey: "k-1" },
        { id: "s-2", fileKey: "k-2" },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const storage = {
    delete: jest.fn(async (key: string) => {
      if (failKeys.includes(key)) throw new Error("storage unreachable");
      deleted.push(key);
    }),
  };
  const audit = {
    record: jest.fn(async (e: { action: string; metadata?: Record<string, unknown> }) => {
      audited.push(e);
    }),
  };
  const service = new PrivacyService(db as never, audit as never, storage as never);
  return { service, audited, deleted, storage };
}

describe("approving an erasure", () => {
  it("deletes the bytes for every file", async () => {
    const { service, deleted } = makeService();
    await service.reviewErasure(controller, "req-1", "APPROVED");
    expect(deleted).toEqual(["k-1", "k-2"]);
  });

  it("records the approval with the count", async () => {
    const { service, audited } = makeService();
    await service.reviewErasure(controller, "req-1", "APPROVED");
    const approval = audited.find((a) => a.action === "privacy.erasure.approved");
    expect(approval?.metadata).toMatchObject({ erasedSubmissionFiles: 2 });
  });
});

describe("when storage refuses", () => {
  it("records that the erasure was INCOMPLETE, naming the keys", async () => {
    // The whole point. Without this the file survives with no pointer, and every
    // record says it was destroyed.
    const { service, audited } = makeService({ failKeys: ["k-2"] });
    await service.reviewErasure(controller, "req-1", "APPROVED");
    const incomplete = audited.find((a) => a.action === "privacy.erasure.incomplete");
    expect(incomplete).toBeDefined();
    expect(incomplete?.metadata).toMatchObject({ failedKeys: ["k-2"], failed: 1, of: 2 });
  });

  it("still deletes the ones it can", async () => {
    // One unreachable object must not abandon the rest.
    const { service, deleted } = makeService({ failKeys: ["k-1"] });
    await service.reviewErasure(controller, "req-1", "APPROVED");
    expect(deleted).toEqual(["k-2"]);
  });

  it("does not throw — the database erasure already committed", async () => {
    const { service } = makeService({ failKeys: ["k-1", "k-2"] });
    await expect(service.reviewErasure(controller, "req-1", "APPROVED")).resolves.toBeDefined();
  });

  it("writes NO incomplete record when everything went", async () => {
    // An alarm that fires on success is one people learn to ignore.
    const { service, audited } = makeService();
    await service.reviewErasure(controller, "req-1", "APPROVED");
    expect(audited.some((a) => a.action === "privacy.erasure.incomplete")).toBe(false);
  });
});

describe("rejecting an erasure", () => {
  it("deletes nothing", async () => {
    const { service, deleted, storage } = makeService();
    await service.reviewErasure(controller, "req-1", "REJECTED");
    expect(deleted).toEqual([]);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe("the export bundle says what it contains", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/privacy/privacy.service.ts"),
    "utf8",
  ) as string;

  it("includes the pupil's grades", () => {
    // Unambiguously their personal data, read by the family on every report
    // card, and absent from the bundle while it reported `complete: true`.
    expect(SRC).toMatch(/tx\.subjectResult\.findMany\(\{\s*where: \{ studentId, status: "PUBLISHED" \}/);
  });

  it("published results only", () => {
    // A draft mark is a teacher's working note, not a finding about the pupil.
    expect(SRC).toMatch(/status: "PUBLISHED"/);
  });

  it("names its sections, so `complete` means something", () => {
    expect(SRC).toMatch(/sections: \[/);
    expect(SRC).toMatch(/"grades",/);
  });

  it("names what it EXCLUDES, and why", () => {
    // Silence is what made the missing sections invisible. Integrity signals are
    // deliberately withheld from families (Golden Rule #8) — saying so lets a
    // data subject ask the controller directly.
    expect(SRC).toMatch(/excluded: \[/);
    expect(SRC).toMatch(/section: "integritySignals"/);
    expect(SRC).toMatch(/Ask the school's data controller/);
  });
});
