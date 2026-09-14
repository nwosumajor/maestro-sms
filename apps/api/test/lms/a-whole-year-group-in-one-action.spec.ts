// =============================================================================
// SS1A, SS1B, SS1C — nine form passes to set up three year groups
// =============================================================================
// Creating a class was already structured: Section, Year, Stream and Arm are
// CHOSEN from lists and the name is composed from them, so no two arms can be
// spelled differently. What it was not was PROPORTIONATE — a school opening
// SS1A/B/C, SS2A/B/C and SS3A/B/C re-picked Section, Year and Stream nine times,
// and nothing stopped the ninth pass differing from the first.
//
// AND A CLASS HAD NO ROOM. `ClassSubjectOffering.preferredRoomId` pins ONE
// SUBJECT to a specialist room (Chemistry -> the lab). Nothing said where the
// cohort itself lives, so "which room is SS1A in?" — the question a visitor, a
// cover teacher and a parent all ask first — had no answer in the product.
// =============================================================================

import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "S",
  userId: "head",
  roles: ["principal"],
  permissions: ["class.write", "class.read"],
};

function makeService(opts: { existingNames?: string[]; roomTakenBy?: Record<string, string> } = {}) {
  const { existingNames = [], roomTakenBy = {} } = opts;
  const created: Array<{ name: string; arm: string | null; homeRoomId: string | null; supervisorId: string }> = [];
  const tx = {
    class: {
      findFirst: jest.fn(async (a: { where: Record<string, unknown> }) => {
        const w = a.where as { name?: { equals?: string }; homeRoomId?: string };
        if (w.name?.equals) {
          const n = w.name.equals.toLowerCase();
          return existingNames.some((e) => e.toLowerCase() === n) || created.some((c) => c.name.toLowerCase() === n)
            ? { id: "dup" }
            : null;
        }
        if (w.homeRoomId) {
          const byFixture = roomTakenBy[w.homeRoomId];
          // A room claimed EARLIER IN THIS BATCH must be seen too, or the batch
          // can hand the same room to two arms and only the database stops it.
          const byBatch = created.find((c) => c.homeRoomId === w.homeRoomId)?.name;
          return byFixture || byBatch ? { name: byFixture ?? byBatch } : null;
        }
        return null;
      }),
      create: jest.fn(async (a: { data: { name: string; arm: string | null; homeRoomId: string | null; supervisorId: string } }) => {
        created.push(a.data);
        return { id: `c-${created.length}`, ...a.data };
      }),
      count: jest.fn(async () => 0),
      // nextCode reads every existing code to allocate the next one.
      findMany: jest.fn(async () => created.map((_, i) => ({ code: `cls${i}` }))),
    },
    room: { findFirst: jest.fn(async (a: { where: { id: string } }) => ({ id: a.where.id, name: `Hall ${a.where.id.slice(-1).toUpperCase()}` })) },
    user: {
      findMany: jest.fn(async (a: { where: { id: { in: string[] } } }) =>
        a.where.id.in.map((id) => ({ id, name: "A Teacher", status: "ACTIVE", roles: [{ role: { name: "teacher" } }] })),
      ),
      findFirst: jest.fn(async () => ({ id: "t", name: "A Teacher", status: "ACTIVE" })),
    },
    // assertMayTeach reads the ROLE rows to check the supervisor may teach — a
    // double missing it fails as a code fault, which is exactly how it presented.
    userRole: {
      findMany: jest.fn(async (a: { where: { userId: { in: string[] } } }) =>
        a.where.userId.in.map((userId) => ({ userId, role: { name: "teacher" } })),
      ),
    },
    classSubjectOffering: { findMany: jest.fn(async () => []) },
    subject: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = new LmsService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
  );
  return { svc, created, tx };
}

const arms = (letters: string[], room?: (l: string) => string) =>
  letters.map((l) => ({ arm: l, supervisorId: `00000000-0000-0000-0000-00000000000${letters.indexOf(l) + 1}`, ...(room ? { homeRoomId: room(l) } : {}) }));

describe("creating a whole stream's arms at once", () => {
  it("creates SS1A, SS1B and SS1C in one action", async () => {
    const { svc, created } = makeService();
    const r = await svc.createArms(head, { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", arms: arms(["A", "B", "C"]) });
    expect(r.created).toHaveLength(3);
    expect(r.skipped).toEqual([]);
    expect(created.map((c) => c.arm)).toEqual(["A", "B", "C"]);
  });

  it("gives every arm its OWN class teacher — the rule a bulk door must not bypass", async () => {
    // A class without one has a roll, a timetable and nobody responsible for its
    // register. An endpoint that made it easier to skip that would be a way
    // round the check rather than a shortcut through it.
    const { svc, created } = makeService();
    await svc.createArms(head, { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", arms: arms(["A", "B"]) });
    expect(created.every((c) => !!c.supervisorId)).toBe(true);
    expect(new Set(created.map((c) => c.supervisorId)).size).toBe(2);
  });

  it("SKIPS an arm that already exists and says which, instead of failing the batch", async () => {
    // Re-running after fixing one row must not mean deleting the rest — which is
    // what an all-or-nothing batch would force.
    const { svc } = makeService({ existingNames: ["SS1 Science B"] });
    const r = await svc.createArms(head, { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", arms: arms(["A", "B", "C"]) });
    expect(r.created).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].arm).toBe("B");
    expect(r.skipped[0].reason).toMatch(/already exists/i);
  });

  it("is idempotent — pressing it twice creates nothing the second time", async () => {
    const { svc } = makeService();
    const input = { stage: "SENIOR_SECONDARY" as const, level: 1, stream: "SCIENCE" as const, arms: arms(["A", "B"]) };
    const first = await svc.createArms(head, input);
    const second = await svc.createArms(head, input);
    expect(first.created).toHaveLength(2);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
  });
});

describe("a class's base room", () => {
  it("assigns one per arm — SS1A in Hall A, SS1B in Hall B", async () => {
    const { svc, created } = makeService();
    const room = (l: string) => `00000000-0000-0000-0000-0000000000a${l === "A" ? 1 : 2}`;
    await svc.createArms(head, { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", arms: arms(["A", "B"], room) });
    expect(created.map((c) => c.homeRoomId)).toEqual([room("A"), room("B")]);
  });

  it("REFUSES a room another class already lives in, and NAMES that class", async () => {
    // "Unique constraint failed" sends somebody hunting; naming the class does
    // not. The database still guarantees it — this is what makes the refusal
    // actionable.
    const taken = "00000000-0000-0000-0000-0000000000a1";
    const { svc } = makeService({ roomTakenBy: { [taken]: "SS1 Science A" } });
    const r = await svc.createArms(head, {
      stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE",
      arms: [{ arm: "B", supervisorId: "00000000-0000-0000-0000-000000000002", homeRoomId: taken }],
    });
    expect(r.created).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/already the base room for SS1 Science A/);
  });

  it("will not hand ONE room to two arms of the same batch", async () => {
    // The batch is the likeliest place to do it by accident, and each arm is its
    // own transaction — so an arm must see a room claimed moments earlier.
    const room = "00000000-0000-0000-0000-0000000000a1";
    const { svc } = makeService();
    const r = await svc.createArms(head, {
      stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE",
      arms: [
        { arm: "A", supervisorId: "00000000-0000-0000-0000-000000000001", homeRoomId: room },
        { arm: "B", supervisorId: "00000000-0000-0000-0000-000000000002", homeRoomId: room },
      ],
    });
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].arm).toBe("B");
  });

  it("leaves the room NULL when none is given — not every school assigns one", async () => {
    const { svc, created } = makeService();
    await svc.createArms(head, { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", arms: arms(["A"]) });
    expect(created[0].homeRoomId).toBeNull();
  });
});
