// =============================================================================
// Every warden in the school was told which child was missing
// =============================================================================
// The hourly sweep alerts staff when a boarder has not signed back in from an
// exeat. The alert names the child and where they went:
//
//     title: `${name} is late back from exeat`
//     body:  `${name} was due back at ... from ${destination} and has not signed in.`
//
// It went to every holder of warden / head_warden / school_admin / principal in
// the school. A warden's authority is their OWN hostel — `assertHostelInScope`
// enforces exactly that on every other hostel read and write, 404 for anything
// else — so this sweep was the one place that ignored the module's own rule, and
// a warden of Hostel B learned that a named child from Hostel A was missing and
// which address they had gone to.
//
// Not a dramatic breach: these are all staff, and the alert is urgent. But it is
// a minor's whereabouts going to somebody with no responsibility for them, in a
// module that is otherwise careful about exactly this, and the fix costs one
// lookup the sweep was already positioned to make.
//
// Head wardens and the school office stay school-wide, because they are
// school-wide by design.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExeatOverdueService } from "../../src/hostel/exeat-overdue.service";

/** Drives the real sweep. The cases below are about WHO is told and WHICH
 *  exeats end up marked, and neither can be read off the source. */
function makeService(opts: {
  exeats: Array<Record<string, unknown>>;
  staff?: Array<{ userId: string }>;
  hostels?: Array<{ id: string; wardenId: string | null }>;
  guardians?: Array<{ studentId: string; parentId: string }>;
}) {
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const client = {
    // Every real privileged client can read the school registry; the sweep asks
    // for each school's timezone so "due back at 18:00" is the school's clock.
    school: { findMany: jest.fn().mockResolvedValue([]) },
    hostelExeat: { findMany: jest.fn().mockResolvedValue(opts.exeats), updateMany },
    userRole: { findMany: jest.fn().mockResolvedValue(opts.staff ?? []) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "kid-1", name: "Ada Obi" }, { id: "kid-2", name: "Bola Ade" }]) },
    hostel: { findMany: jest.fn().mockResolvedValue(opts.hostels ?? [{ id: "h-1", wardenId: "warden-1" }]) },
    parentChild: { findMany: jest.fn().mockResolvedValue(opts.guardians ?? []) },
  };
  const svc = Object.create(ExeatOverdueService.prototype) as ExeatOverdueService;
  Object.assign(svc, {
    db: { client },
    notifications: { enqueueMany },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, updateMany, enqueueMany };
}

const exeat = (id: string, hostelId: string, studentId: string) => ({
  id,
  schoolId: "A",
  hostelId,
  studentId,
  destination: "home",
  expectedReturnAt: new Date("2026-08-20T18:00:00Z"),
});

const SRC = readFileSync(join(__dirname, "../../src/hostel/exeat-overdue.service.ts"), "utf8");
const HOSTEL = readFileSync(join(__dirname, "../../src/hostel/hostel.service.ts"), "utf8");

describe("who is told a boarder is late back", () => {
  it("the school-wide roles no longer include a plain warden", () => {
    expect(SRC).toMatch(/const SCHOOL_WIDE_ALERT_ROLES = \["head_warden", "school_admin", "principal"\]/);
    expect(SRC).not.toMatch(/ALERT_ROLES = \["warden"/);
  });

  it("the hostel's OWN warden is added, and another hostel's is not", async () => {
    const { svc, enqueueMany } = makeService({
      exeats: [exeat("e-1", "h-1", "kid-1")],
      staff: [],
      hostels: [
        { id: "h-1", wardenId: "warden-1" },
        { id: "h-2", wardenId: "warden-2" },
      ],
    });
    await svc.sweep();
    expect(enqueueMany.mock.calls[0][1]).toEqual(["warden-1"]);
  });

  it("nobody is told twice", async () => {
    // A head warden who also wardens this hostel appears in both lists.
    const { svc, enqueueMany } = makeService({
      exeats: [exeat("e-1", "h-1", "kid-1")],
      staff: [{ userId: "warden-1" }],
      hostels: [{ id: "h-1", wardenId: "warden-1" }],
    });
    await svc.sweep();
    expect(enqueueMany.mock.calls[0][1]).toEqual(["warden-1"]);
  });

  it("resolves the warden from the hostel, in the same batch as the names", () => {
    // One extra read for the whole school's overdue set, not one per exeat.
    expect(SRC).toMatch(/client\.hostel\.findMany\(\{[\s\S]{0,160}select: \{ id: true, wardenId: true \}/);
  });
});

describe("when there is nobody to tell", () => {
  // These were source-text assertions, and that is HOW the defect below
  // survived: the "left unmarked" one took a 480-character window after the
  // skip and checked `overdueNotifiedAt` did not appear in it. The marking was
  // thirty lines further down, outside the window — so the test proved two
  // strings were near each other and never proved the exeat was left alone.
  // They now drive the sweep.

  it("leaves the exeat UNMARKED so the next hour tries again", async () => {
    // No school-wide staff, this hostel has no warden, this child has no
    // guardian on record: nobody learns the child is missing. Marking it would
    // record the one case nobody was told about as handled — and the sweep
    // would never look at it again.
    const { svc, updateMany, enqueueMany } = makeService({
      exeats: [exeat("e-1", "h-nowarden", "kid-1")],
      staff: [],
      hostels: [{ id: "h-nowarden", wardenId: null }],
    });
    await svc.sweep();
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("marks only the exeats somebody was actually told about", async () => {
    // The bug in one case: two overdue children, one hostel with a warden and
    // one without, and no school-wide staff. The alert goes out for the first;
    // the bulk update used to mark BOTH.
    const { svc, updateMany, enqueueMany } = makeService({
      exeats: [exeat("e-told", "h-1", "kid-1"), exeat("e-silent", "h-nowarden", "kid-2")],
      staff: [],
      hostels: [
        { id: "h-1", wardenId: "warden-1" },
        { id: "h-nowarden", wardenId: null },
      ],
    });
    await svc.sweep();
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.id).toEqual({ in: ["e-told"] });
  });

  it("still says so, per hostel", async () => {
    const { svc } = makeService({
      exeats: [exeat("e-1", "h-nowarden", "kid-1")],
      staff: [],
      hostels: [{ id: "h-nowarden", wardenId: null }],
    });
    await svc.sweep();
    expect(SRC).toMatch(/boarder overdue but nobody to alert/);
  });
});

describe("telling the family", () => {
  // Guardians are notified when an exeat is approved, when the child signs out
  // and when they sign back in — and were told nothing in the one case that
  // matters. The destination is usually home, so the guardian is very often the
  // only person who can say where the child actually is.

  it("alerts the guardians as well as the staff", async () => {
    const { svc, enqueueMany } = makeService({
      exeats: [exeat("e-1", "h-1", "kid-1")],
      staff: [{ userId: "principal-1" }],
      guardians: [{ studentId: "kid-1", parentId: "mum-1" }],
    });
    await svc.sweep();
    const audiences = enqueueMany.mock.calls.map((c) => c[1] as string[]);
    expect(audiences).toEqual([["principal-1", "warden-1"], ["mum-1"]]);
  });

  it("gives the family a DIFFERENT instruction from the staff", async () => {
    // "Record the return on the hostel page" is telling a parent to do
    // something they cannot do. What the school needs from them is where the
    // child is.
    const { svc, enqueueMany } = makeService({
      exeats: [exeat("e-1", "h-1", "kid-1")],
      staff: [{ userId: "principal-1" }],
      guardians: [{ studentId: "kid-1", parentId: "mum-1" }],
    });
    await svc.sweep();
    const [staffMsg, familyMsg] = enqueueMany.mock.calls.map((c) => c[2] as { body: string });
    expect(staffMsg.body).toMatch(/record the return on the hostel page/i);
    expect(familyMsg.body).toMatch(/contact the school/i);
    expect(familyMsg.body).not.toMatch(/hostel page/i);
  });

  it("alerts the family even when the school has no warden or office to act", async () => {
    // The configuration where a parent finding out matters MOST.
    const { svc, enqueueMany, updateMany } = makeService({
      exeats: [exeat("e-1", "h-nowarden", "kid-1")],
      staff: [],
      hostels: [{ id: "h-nowarden", wardenId: null }],
      guardians: [{ studentId: "kid-1", parentId: "mum-1" }],
    });
    await svc.sweep();
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect(enqueueMany.mock.calls[0][1]).toEqual(["mum-1"]);
    // Told somebody, so it counts as handled.
    expect(updateMany.mock.calls[0][0].where.id).toEqual({ in: ["e-1"] });
  });
});

describe("what the alert still is", () => {
  it("stays ESSENTIAL, so a per-type mute cannot silence it", () => {
    expect(SRC).toMatch(/type: "OPERATOR_ALERT"/);
  });

  it("is only marked as sent AFTER it goes out", () => {
    expect(SRC).toMatch(/overdueNotifiedAt/);
  });
});

describe("the rule this now matches", () => {
  it("hostel reads scope a warden to their own hostel", () => {
    // The rule the sweep was the exception to.
    expect(HOSTEL).toMatch(/A warden may only act on their own hostel/);
    expect(HOSTEL).toMatch(/h\.wardenId !== p\.userId\) throw new NotFoundException/);
  });
});
