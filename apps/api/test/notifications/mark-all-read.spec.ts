// =============================================================================
// Mark all read — one statement, and only ever your own
// =============================================================================
// The web looped `POST :id/read`, one sequential round trip per notification.
// A full inbox was dozens of latencies, and a failure halfway left some read
// and some not with nothing on screen to say so.
//
// "All" is the word that has to be scoped: all of MINE. There is no form of
// this that may touch another person's inbox, and that is the only thing here
// worth a security test.
// =============================================================================

import { NotificationService } from "../../src/notifications/notification.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const me = { userId: "u1", schoolId: "s1", roles: ["parent"], permissions: [] } as unknown as Principal;

function harness(count: number) {
  let where: Record<string, unknown> | null = null;
  let calls = 0;
  const tx = {
    notification: {
      updateMany: jest.fn((args: { where: Record<string, unknown> }) => {
        where = args.where;
        calls += 1;
        return Promise.resolve({ count });
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new NotificationService(db as never, { record: jest.fn() } as never, { add: jest.fn() } as never);
  return { svc, get where() { return where; }, get calls() { return calls; } };
}

describe("markAllRead", () => {
  it("is ONE statement however many are unread", async () => {
    // The whole point: the cost must not grow with the size of the inbox.
    const h = harness(40);
    await expect(h.svc.markAllRead(me)).resolves.toEqual({ read: 40 });
    expect(h.calls).toBe(1);
  });

  it("touches only the CALLER'S unread rows", async () => {
    // "All" means all of mine. Dropping recipientId would mark the school's
    // entire notification table read.
    const h = harness(3);
    await h.svc.markAllRead(me);
    expect(h.where).toEqual({ recipientId: "u1", readAt: null });
  });

  it("reports zero rather than failing when nothing is unread", async () => {
    const h = harness(0);
    await expect(h.svc.markAllRead(me)).resolves.toEqual({ read: 0 });
  });
});
