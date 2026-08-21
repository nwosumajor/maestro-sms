// =============================================================================
// Writing to twenty years of alumni
// =============================================================================
// The broadcast looped over every recipient calling `enqueue` ONE AT A TIME, and
// each call opens its own tenant transaction. So a school writing to its alumni
// body did one transaction per person, sequentially, inside a single HTTP
// request. Ten thousand alumni is ten thousand round trips: the request times
// out, and the `sent` counter that would have said how far it got never returns.
//
// Alumni are the distinctive case. A sweep of all 28 loops that enqueue one
// notification at a time found the rest fan out to a pupil's guardians, the
// platform owners, or a school's finance team — handfuls. An alumni body only
// ever accumulates: nobody stops being an alumnus.
//
// `enqueueMany` already existed for exactly this, and the meeting announcer
// already used it in chunks with the reasoning written out. This borrowed the
// pattern rather than inventing a second one.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AlumniService } from "../../src/alumni/alumni.service";

function makeService(count: number) {
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const add = jest.fn().mockResolvedValue(undefined);
  const rows = Array.from({ length: count }, (_, i) => ({ userId: `alum-${i}` }));
  const tx = {
    alumnus: {
      findMany: jest.fn().mockResolvedValue(rows),
      // TWO questions now, not one: how many can be written to, and how many
      // cannot. A stub that answers both with the same number would report the
      // whole register as unreachable. This fixture links every alumnus.
      count: jest.fn(({ where }: { where: { userId?: unknown } }) =>
        Promise.resolve(where?.userId === null ? 0 : count),
      ),
    },
  };
  const svc = Object.create(AlumniService.prototype) as AlumniService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueueMany, enqueue },
    queue: { add },
    logger: { error: jest.fn(), log: jest.fn() },
  });
  return { svc, enqueueMany, enqueue, add, tx };
}

const p = { schoolId: "S", userId: "admin-1", roles: ["school_admin"], permissions: [] } as never;
const msg = { title: "Reunion", body: "Come back on the 12th" };

describe("an alumni broadcast", () => {
  it("sends in CHUNKS, not one transaction per person", async () => {
    const { svc, enqueueMany, enqueue } = makeService(450);
    await svc.fanOutBroadcast({ schoolId: "S", actorId: "admin-1" }, msg);
    // 450 recipients at 200 per chunk = 3 calls, not 450.
    expect(enqueueMany).toHaveBeenCalledTimes(3);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reaches every one of them", async () => {
    const { svc, enqueueMany } = makeService(450);
    const sent = await svc.fanOutBroadcast({ schoolId: "S", actorId: "admin-1" }, msg);
    const reached = enqueueMany.mock.calls.reduce((n, c) => n + (c[1] as string[]).length, 0);
    expect(reached).toBe(450);
    expect(sent).toBe(450);
  });

  it("counts what was actually WRITTEN when a chunk fails", async () => {
    // `sent` has to be the number that landed. Overstating it means an
    // administrator does not resend; understating it means they resend to
    // people who already had it.
    const { svc, enqueueMany } = makeService(450);
    enqueueMany.mockRejectedValueOnce(new Error("db blip"));
    const sent = await svc.fanOutBroadcast({ schoolId: "S", actorId: "admin-1" }, msg);
    expect(sent).toBe(250); // 450 - the 200 in the failed chunk
  });

  it("carries on after a failed chunk rather than abandoning the rest", async () => {
    // A chunk that fails costs that chunk, not the lot.
    const { svc, enqueueMany } = makeService(450);
    enqueueMany.mockRejectedValueOnce(new Error("db blip"));
    await svc.fanOutBroadcast({ schoolId: "S", actorId: "admin-1" }, msg);
    expect(enqueueMany).toHaveBeenCalledTimes(3);
  });

  it("writes nothing when there is nobody to write to", async () => {
    const { svc, enqueueMany } = makeService(0);
    expect(await svc.fanOutBroadcast({ schoolId: "S", actorId: "admin-1" }, msg)).toBe(0);
    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it("uses the same chunk size as the meeting announcer", () => {
    // One constant, one reason. Two different chunk sizes in one codebase is a
    // question nobody can answer later.
    const alumni = readFileSync(join(__dirname, "../../src/alumni/alumni.service.ts"), "utf8");
    const meeting = readFileSync(join(__dirname, "../../src/meeting/meeting.service.ts"), "utf8");
    const of = (s: string, name: string) => s.match(new RegExp(`const ${name} = (\\d+)`))?.[1];
    expect(of(alumni, "BROADCAST_CHUNK")).toBe(of(meeting, "ANNOUNCE_CHUNK"));
  });
});

describe("the request itself", () => {
  it("QUEUES the fan-out instead of doing it inline", async () => {
    // Measured before this: 12.9 seconds for 2,000 alumni even chunked, because
    // every inbox row, delivery row and audit row was written while the
    // administrator waited. Ten thousand would pass the gateway timeout and
    // report nothing but failure.
    const { svc, add, enqueueMany } = makeService(2000);
    const out = await svc.broadcast(p, msg);
    expect(add).toHaveBeenCalledTimes(1);
    expect(enqueueMany).not.toHaveBeenCalled();
    // `unreachable` rides alongside since a broadcast now says how much of the
    // register it could NOT write to; this stub links every alumnus.
    expect(out).toEqual({ queued: 2000, unreachable: 0 });
  });

  it("counts without loading every alumnus to do it", async () => {
    // The request needs a NUMBER, not the roll. Hydrating ten thousand rows
    // through the ORM to call `.length` is the thing this change is about, and
    // it would reappear the moment somebody reached for findMany here.
    const { svc, tx } = makeService(2000);
    await svc.broadcast(p, msg);
    expect(tx.alumnus.count).toHaveBeenCalled();
    expect(tx.alumnus.findMany).not.toHaveBeenCalled();
  });

  it("queues nothing when there is nobody to write to", async () => {
    const { svc, add } = makeService(0);
    expect(await svc.broadcast(p, msg)).toEqual({ queued: 0, unreachable: 0 });
    expect(add).not.toHaveBeenCalled();
  });
});
