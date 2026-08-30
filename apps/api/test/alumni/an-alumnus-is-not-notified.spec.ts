/**
 * AN ALUMNUS IS NOT A USER THE SCHOOL NOTIFIES.
 *
 * A broadcast used to be a NOTIFICATION addressed to a user account, and the
 * notification funnel drops every external channel for a recipient whose status
 * is not ACTIVE (`persist`) — which an alumnus is BY DEFINITION, since leaving
 * is what makes somebody an alumnus. Two consequences, and both were wrong:
 *
 *   - a properly-exited alumnus received NOTHING, while the count said queued;
 *   - the few who DID receive it were the ones whose exit had never been
 *     processed — people the school still believed were enrolled.
 *
 * So the audience is the ALUMNI REGISTER'S OWN EMAIL, the contact detail this
 * module exists to hold precisely because the account is closed, sent directly
 * through EmailService — the use `NotificationModule` already documents it for,
 * "DIRECT sends to non-users".
 *
 * THE DEPARTED-RECIPIENT RULE IS UNTOUCHED. Nothing here writes a notification,
 * so no message lands in an inbox its owner cannot open, and no exemption was
 * carved into the funnel to make this work.
 */
import { AlumniService } from "../../src/alumni/alumni.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Alumnus = { email: string | null; userId?: string | null; graduationYear?: number | null };

function makeService(rows: Alumnus[]) {
  const sent: Array<{ to: string; subject: string }> = [];
  // The harness HONOURS the where: `email: { not: null }` and `email: null` are
  // two different questions, and a stub answering both the same way is how a
  // dropped filter keeps passing.
  const matches = (r: Alumnus, where: { email?: unknown; userId?: unknown; graduationYear?: number }) => {
    if (where.graduationYear !== undefined && r.graduationYear !== where.graduationYear) return false;
    // `userId` is honoured too, so a query that goes back to selecting the
    // audience by ACCOUNT is visible here rather than silently equivalent —
    // the mutation that restored it passed against a stub that ignored the key.
    if (where.userId === null && r.userId != null) return false;
    if (where.userId && typeof where.userId === "object" && r.userId == null) return false;
    if (where.email === null) return r.email === null;
    if (where.email && typeof where.email === "object") return r.email !== null;
    return true;
  };
  const tx = {
    alumnus: {
      count: jest.fn(({ where }: { where: never }) => Promise.resolve(rows.filter((r) => matches(r, where)).length)),
      findMany: jest.fn(({ where }: { where: never }) =>
        Promise.resolve(rows.filter((r) => matches(r, where)).map((r) => ({ email: r.email }))),
      ),
    },
  } as unknown as TenantTx;

  const email = {
    send: jest.fn((to: string, subject: string) => {
      sent.push({ to, subject });
      return Promise.resolve({ ok: true });
    }),
  };
  const notifications = { enqueue: jest.fn(), enqueueMany: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };

  const svc = Object.create(AlumniService.prototype) as AlumniService;
  Object.assign(svc, {
    db: {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    },
    audit: { record: jest.fn() },
    email,
    queue,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, email, notifications, queue, sent, tx };
}

const P = { userId: "staff-1", schoolId: "school-1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

describe("who an alumni broadcast reaches", () => {
  it("emails the address on the register, and notifies nobody", async () => {
    const { svc, email, notifications, sent } = makeService([
      { email: "ada@old.example" },
      { email: "bola@old.example" },
    ]);
    const sentCount = await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, {
      title: "Homecoming",
      body: "Come back on the 4th.",
    });
    expect(sentCount).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual(["ada@old.example", "bola@old.example"]);
    expect(email.send).toHaveBeenCalledTimes(2);
    // THE POINT OF THE WHOLE CHANGE: not one notification is written.
    expect(notifications.enqueue).not.toHaveBeenCalled();
    expect(notifications.enqueueMany).not.toHaveBeenCalled();
  });

  it("reaches an alumnus recorded AFTER THE FACT, who never had an account", async () => {
    // The schema calls `userId` "null if recorded after the fact", and that is
    // most of a register: a school enters its old pupils from paper. Selecting
    // the audience by account excluded exactly them.
    const { svc, sent } = makeService([
      { email: "ada@old.example", userId: null },
      { email: "bola@old.example", userId: "u-1" },
    ]);
    const count = await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, { title: "t", body: "b" });
    expect(count).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual(["ada@old.example", "bola@old.example"]);
  });

  it("skips an alumnus with no address rather than inventing one", async () => {
    const { svc, sent } = makeService([{ email: "ada@old.example" }, { email: null }]);
    const count = await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, { title: "t", body: "b" });
    expect(count).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("counts a refused address as NOT sent", async () => {
    // `EmailService.send` reports rather than throwing, and a broadcast that
    // counts an unaccepted address as reached is the silent-success shape.
    const { svc, email } = makeService([{ email: "a@x.example" }, { email: "b@x.example" }]);
    email.send = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "provider 400" });
    const count = await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, { title: "t", body: "b" });
    expect(count).toBe(1);
  });

  it("one bad address does not abandon the rest", async () => {
    const { svc, email } = makeService([{ email: "a@x.example" }, { email: "b@x.example" }, { email: "c@x.example" }]);
    email.send = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true });
    const count = await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, { title: "t", body: "b" });
    expect(count).toBe(2);
  });

  it("narrows to a graduation year when one is given", async () => {
    const { svc, sent } = makeService([
      { email: "a@x.example", graduationYear: 2015 },
      { email: "b@x.example", graduationYear: 2016 },
    ]);
    await svc.fanOutBroadcast({ schoolId: "school-1", actorId: "staff-1" }, { title: "t", body: "b", year: 2015 });
    expect(sent.map((s) => s.to)).toEqual(["a@x.example"]);
  });
});

describe("what a broadcast reports", () => {
  it("says how many it can reach and how many have no address", async () => {
    const { svc } = makeService([{ email: "a@x.example" }, { email: null }, { email: null }]);
    await expect(svc.broadcast(P, { title: "t", body: "b" })).resolves.toEqual({
      queued: 1,
      unreachable: 2,
      noEmail: 2,
    });
  });

  it("queues nothing at all when nobody has an address", async () => {
    const { svc, queue } = makeService([{ email: null }]);
    const r = await svc.broadcast(P, { title: "t", body: "b" });
    expect(r.queued).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("QUEUES the fan-out rather than sending inline", async () => {
    const { svc, queue, email } = makeService([{ email: "a@x.example" }]);
    await svc.broadcast(P, { title: "t", body: "b" });
    expect(queue.add).toHaveBeenCalledTimes(1);
    // The request returns before anything is sent; the processor does the work.
    expect(email.send).not.toHaveBeenCalled();
  });

  it("records the shortfall in the audit entry, not only on the screen", async () => {
    const { svc } = makeService([{ email: "a@x.example" }, { email: null }]);
    const audit = (svc as unknown as { audit: { record: jest.Mock } }).audit;
    await svc.broadcast(P, { title: "t", body: "b" });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ noEmail: 1 }) }),
      expect.anything(),
    );
  });

  it("counts in the DATABASE, never by loading the register", async () => {
    // An alumni roll only ever grows — nobody stops being an alumnus — so
    // hydrating every row to answer three numbers is the habit this repo names.
    const { svc, tx } = makeService([{ email: "a@x.example" }]);
    await svc.broadcast(P, { title: "t", body: "b" });
    expect((tx.alumnus.count as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    expect(tx.alumnus.findMany).not.toHaveBeenCalled();
  });
});
