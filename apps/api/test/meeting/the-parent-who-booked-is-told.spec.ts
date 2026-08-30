/**
 * A PARENT WHO BOOKS A MEETING IS TOLD, IN THEIR OWN LANGUAGE, AT THE SCHOOL'S
 * CLOCK.
 *
 * Three defects met in one place.
 *
 * 1. `book()` notified ONLY the teacher. This module's own description says
 *    both parties are notified on book and cancel, and `cancelBooking` one
 *    method below does exactly that — sibling asymmetry, with the correct half
 *    written second. A parent holds no record of a time they typed into a form.
 *
 * 2. The translated message for that notice — `meeting.booked`, "Votre
 *    rendez-vous avec {host} … est confirmé" — had been sitting in the
 *    catalogue with NO PRODUCER, along with four others. The text was written
 *    ahead of the code and never wired, so a francophone family read English.
 *
 * 3. Both notices rendered the time with `toISOString()`: the SERVER's UTC. A
 *    meeting happens at the school, so a parent in Lagos was told to come an
 *    hour early and one in Toronto four hours late — on the single message that
 *    says when to turn up.
 */
import { resolveRegion } from "@sms/types";
import { MeetingService } from "../../src/meeting/meeting.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const parent: Principal = { schoolId: "A", userId: "par1", roles: ["parent"], permissions: ["meeting.book"] };

function harness(timezone: string | null) {
  const sent: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone }) },
    parentChild: { findFirst: jest.fn().mockResolvedValue({ id: "link" }) },
    meetingSlot: {
      findFirst: jest.fn().mockResolvedValue({
        id: "sl1",
        teacherId: "t1",
        capacity: 5,
        // 09:30 UTC — 10:30 in Lagos, and still the previous evening in Toronto.
        startsAt: new Date("2099-03-05T09:30:00.000Z"),
        kind: "APPOINTMENT",
      }),
    },
    meetingBooking: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: "bk1", slotId: "sl1", studentId: "s1", status: "BOOKED", note: null }),
    },
    // HONOURS THE WHERE: the student and the host are two different lookups and
    // a stub answering both with one name cannot tell them apart.
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "t1" ? { name: "Mr Bello" } : { id: "s1", name: "Ada" }),
      ),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = {
    enqueue: jest.fn((_c: unknown, n: Record<string, unknown>) => {
      sent.push(n);
      return Promise.resolve({});
    }),
    enqueueMany: jest.fn().mockResolvedValue({}),
  };
  return {
    svc: new MeetingService(db as never, { record: jest.fn() } as never, notifications as never,
      // The harness's OWN zone — this suite exists to prove a school west of UTC
      // is dated by its own day, so a fixed stub here would assert nothing.
      // `resolveRegion` still supplies the platform default when it is null.
      {
        forSchool: jest.fn().mockResolvedValue({ timezone: resolveRegion({ timezone }).timezone }),
        inTx: jest.fn().mockResolvedValue({ timezone: resolveRegion({ timezone }).timezone }),
      } as never,
    ),
    sent,
  };
}

describe("the parent who booked is told", () => {
  it("notifies the parent as well as the teacher", async () => {
    const { svc, sent } = harness(null);
    await svc.book(parent, "sl1", "s1");
    expect(sent.map((n) => n.recipientId).sort()).toEqual(["par1", "t1"]);
  });

  it("carries the catalogue KEY, so a francophone family reads French", async () => {
    // The producer must not compose the sentence: rendering happens per
    // RECIPIENT, at the moment the row is written.
    const { svc, sent } = harness(null);
    await svc.book(parent, "sl1", "s1");
    const toParent = sent.find((n) => n.recipientId === "par1")!;
    expect(toParent.key).toBe("meeting.booked");
    expect(toParent.params).toMatchObject({ host: "Mr Bello", student: "Ada" });
  });

  it("states the time in the SCHOOL's clock, not the server's", async () => {
    const { svc, sent } = harness("Africa/Lagos");
    await svc.book(parent, "sl1", "s1");
    const toParent = sent.find((n) => n.recipientId === "par1")!;
    // 09:30Z is 10:30 in Lagos. The old code printed the UTC 09:30.
    expect(String((toParent.params as Record<string, string>).date)).toContain("10:30");
    expect(String(toParent.body)).not.toContain("09:30");
  });

  it("dates it by the school's day too — west of UTC that is the day before", async () => {
    const { svc, sent } = harness("America/Toronto");
    await svc.book(parent, "sl1", "s1");
    const toParent = sent.find((n) => n.recipientId === "par1")!;
    // 2099-03-05T09:30Z is 04:30 on the 5th in Toronto; the guard is that the
    // DATE is resolved through the school's zone rather than sliced off the ISO.
    expect(String((toParent.params as Record<string, string>).date)).toContain("2099-03-05");
    expect(String((toParent.params as Record<string, string>).date)).toContain("04:30");
  });

  it("still tells the teacher, and about the right pupil", async () => {
    const { svc, sent } = harness(null);
    await svc.book(parent, "sl1", "s1");
    const toTeacher = sent.find((n) => n.recipientId === "t1")!;
    expect(String(toTeacher.body)).toContain("Ada");
  });
});
