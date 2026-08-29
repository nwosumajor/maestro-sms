// =============================================================================
// "Cancel those first" — an instruction the system forbade
// =============================================================================
// A teacher opens a meeting slot, a parent books it, and the teacher is then off
// sick. Live, before this:
//
//   teacher opens a slot          -> 201
//   parent books it               -> 201
//   TEACHER cancels the booking   -> 403 Forbidden
//   PRINCIPAL cancels the booking -> 403 Forbidden
//   teacher withdraws the slot    -> 409 The slot has bookings — cancel those first
//   only the PARENT can cancel    -> 200
//
// The error message named the one action the system refused to let them take,
// and the only person who could release the slot was the parent.
//
// The SERVICE was right all along: it admits the parent who booked, the teacher
// whose slot it is, and school-wide administrators, and even picks which side to
// notify depending on who cancelled — a branch that could never run. The ROUTE
// was gated on `meeting.book`, which only parents hold, so none of that was
// reachable. Same shape as the discipline evidence fix: the guard answers first,
// and a suite that builds the service directly cannot see a decorator.
//
// There is no single permission meaning "a party to this booking" — `meeting.book`
// is parents, `meeting.host` is staff — so the route carries none and the service
// decides, exactly as `GET approvals/pending` does.
//
// The second half: the host's slot view carried a booking COUNT and nothing else,
// so a teacher could not tell which family was coming, and after the gate was
// fixed still had no booking id to act on. Their own slots now carry the
// bookings. The parent-facing list must NOT — one family seeing another's
// booking would be a worse bug than the one being fixed.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import { MeetingService } from "../../src/meeting/meeting.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const parent: Principal = { schoolId: "S", userId: "parent-1", roles: ["parent"], permissions: ["meeting.book"] };
const teacher: Principal = { schoolId: "S", userId: "teach-1", roles: ["teacher"], permissions: ["meeting.host"] };
const other: Principal = { schoolId: "S", userId: "teach-9", roles: ["teacher"], permissions: ["meeting.host"] };
const head: Principal = { schoolId: "S", userId: "head-1", roles: ["principal"], permissions: ["meeting.host"] };

function makeService() {
  const booking = {
    id: "bk-1",
    parentId: "parent-1",
    status: "BOOKED",
    slot: { teacherId: "teach-1", startsAt: new Date("2026-09-01T09:00:00.000Z") },
  };
  const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
    // The cancellation names the HOST, so the producer resolves their name —
    // every real TenantTx can answer this.
    user: { findFirst: jest.fn(async () => ({ name: "Demo Teacher" })) },
    meetingBooking: {
      findFirst: jest.fn(async () => booking),
      update: jest.fn(async () => ({})),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new MeetingService(
    db as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
  );
  return { service, tx };
}

describe("who may cancel a booking", () => {
  it("the parent who booked it", async () => {
    const { service } = makeService();
    await expect(service.cancelBooking(parent, "bk-1")).resolves.toMatchObject({ cancelled: true });
  });

  it("THE TEACHER whose slot it is — the case that was unreachable", async () => {
    const { service } = makeService();
    await expect(service.cancelBooking(teacher, "bk-1")).resolves.toMatchObject({ cancelled: true });
  });

  it("a school-wide administrator", async () => {
    const { service } = makeService();
    await expect(service.cancelBooking(head, "bk-1")).resolves.toMatchObject({ cancelled: true });
  });

  it("nobody else — another teacher cannot", async () => {
    const { service } = makeService();
    await expect(service.cancelBooking(other, "bk-1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("the route gate, which is what actually blocked it", () => {
  const CONTROLLER = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/meeting/meeting.controller.ts"),
    "utf8",
  ) as string;
  const cancelRoute = CONTROLLER.slice(
    CONTROLLER.indexOf('@Delete("bookings/:id")'),
    CONTROLLER.indexOf('@Delete("bookings/:id")') + 200,
  );

  it("carries no permission — no single one means 'a party to this booking'", () => {
    // Gating on meeting.book locks out every host; meeting.host locks out every
    // parent. The service already knows the answer.
    expect(cancelRoute).not.toMatch(/@RequirePermission/);
  });

  it("the routes that DO have a single natural holder keep their gate", () => {
    // Opening and withdrawing a slot are host actions; booking is a parent one.
    for (const route of ['@Post("slots")', '@Delete("slots/:id")']) {
      const at = CONTROLLER.indexOf(route);
      expect(CONTROLLER.slice(at, at + 160)).toMatch(/MEETING_HOST/);
    }
    const book = CONTROLLER.indexOf('@Post("bookings")');
    expect(CONTROLLER.slice(book, book + 160)).toMatch(/MEETING_BOOK/);
  });
});

describe("a host can see who booked", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/meeting/meeting.service.ts"),
    "utf8",
  ) as string;

  it("their own slots carry the bookings", () => {
    const mine = SRC.slice(SRC.indexOf("async mySlots("), SRC.indexOf("async mySlots(") + 2200);
    expect(mine).toMatch(/bookingsForHost\(tx, slots\.map/);
    expect(mine).toMatch(/bookings: bookings\.get\(s\.id\) \?\? \[\]/);
  });

  it("the PARENT-facing list does not — one family never sees another's", () => {
    // The whole reason this is scoped to mySlots. A leak here would be worse
    // than the deadlock it was added to fix.
    const open = SRC.slice(SRC.indexOf("async openSlots("), SRC.indexOf("async openSlots(") + 2500);
    expect(open).not.toMatch(/bookingsForHost/);
  });

  it("only BOOKED rows, and names never come from the caller", () => {
    const fn = SRC.slice(SRC.indexOf("private async bookingsForHost"), SRC.indexOf("private async bookingCounts"));
    expect(fn).toMatch(/status: "BOOKED"/);
    expect(fn).toMatch(/this\.userNames\(tx,/);
  });
});
