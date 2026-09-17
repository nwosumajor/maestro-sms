// =============================================================================
// The profile showed a pupil's blood group but not which class they sit in
// =============================================================================
// `StudentProfileDto` carried admission number, date of birth, address, contact
// details — and neither the class the pupil is in nor who is responsible for
// them. A teacher or a principal opening a pupil could not see the first thing
// anybody actually wants.
//
// WHY IT IS DERIVED AND NOT STORED. Six writers move a pupil between classes:
// promotion, demotion, graduation, transfer, withdrawal and the two bulk
// importers. A denormalised `currentClassId` would have to be correct in all of
// them, and the one that forgot would leave a pupil showing last year's class
// for ever — with nothing to say it was wrong. Deriving it from the one ACTIVE
// enrolment means a promotion updates the profile by construction, because the
// batch already closes the source enrolment before opening the destination.
//
// Verified on the demo school: 900 pupils, exactly one ACTIVE enrolment each,
// none with two.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "S",
  userId: "head",
  roles: ["principal"],
  permissions: ["student.read", "student.profile.read"],
};

function makeService(opts: {
  enrolment?: { class: { id: string; name: string; supervisorId: string | null; homeRoomId?: string | null } | null } | null;
  supervisor?: { id: string; name: string; status: string } | null;
} = {}) {
  const { enrolment = null, supervisor = null } = opts;
  const tx = {
    studentProfile: { findFirst: jest.fn(async () => ({ studentId: "stu-1", admissionNumber: "ADM-1", dateOfBirth: null, gender: null, phone: null, email: null, addressLine1: null, city: null, state: null, country: null, postalCode: null })) },
    enrollment: { findFirst: jest.fn(async () => enrolment) },
    user: { findFirst: jest.fn(async () => supervisor) },
    auditLog: { create: jest.fn(async () => ({})) },
    parentChild: { findFirst: jest.fn(async () => null) },
    classSubjectTeacher: { findMany: jest.fn(async () => []) },
    class: { findMany: jest.fn(async () => []) },
    // The profile resolves the class's BASE room too — a double missing it
    // fails as a code fault rather than as the wiring change it is.
    room: { findFirst: jest.fn(async () => ({ name: "Hall A" })) },
  } as unknown as TenantTx;
  const svc = new SisService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a pupil's profile says where they are", () => {
  it("names the class from the ACTIVE enrolment", async () => {
    const { svc } = makeService({
      enrolment: { class: { id: "c-jss2", name: "JSS 2A", supervisorId: "t-1" } },
      supervisor: { id: "t-1", name: "Mrs Okafor", status: "ACTIVE" },
    });
    const r = await svc.getProfile(staff, "stu-1");
    expect(r.currentClass).toEqual({ id: "c-jss2", name: "JSS 2A", room: null });
    expect(r.supervisor).toEqual({ id: "t-1", name: "Mrs Okafor" });
  });

  it("says WHICH ROOM the class is in, not only which class", async () => {
    // The base room was settable by three paths and read only by its own
    // uniqueness guard — written and visible nowhere. "Which room is my child
    // in?" is the question a parent and a visitor both ask first.
    const { svc } = makeService({
      enrolment: { class: { id: "c", name: "JSS 2A", supervisorId: null, homeRoomId: "room-1" } },
    });
    const r = await svc.getProfile(staff, "stu-1");
    expect(r.currentClass).toMatchObject({ name: "JSS 2A", room: "Hall A" });
  });

  it("asks for the ACTIVE enrolment, not just any", async () => {
    // A pupil's closed enrolments are their history. Reading one of those would
    // show the class they were in last year and look entirely correct.
    const { svc, tx } = makeService({ enrolment: { class: { id: "c", name: "C", supervisorId: null } } });
    await svc.getProfile(staff, "stu-1");
    const where = (tx as unknown as { enrollment: { findFirst: jest.Mock } }).enrollment.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ studentId: "stu-1", status: "ACTIVE" });
  });

  it("says NOT IN A CLASS rather than leaving it blank", async () => {
    // A pupil on the roll with no placement is a real state — one such pupil
    // exists on the demo school — and it is something somebody must act on.
    const { svc } = makeService({ enrolment: null });
    const r = await svc.getProfile(staff, "stu-1");
    expect(r.currentClass).toBeNull();
    expect(r.supervisor).toBeNull();
    expect(r.supervisorLeft).toBe(false);
  });
});

describe("who is responsible for them", () => {
  it("reports NO SUPERVISOR distinctly from one who has LEFT", async () => {
    // 30 of the demo school's classes have no supervisor at all. That is a rota
    // gap. A class whose named form teacher has exited is a handover nobody
    // finished — a different problem needing a different action, so the two are
    // not collapsed into one blank.
    const none = makeService({ enrolment: { class: { id: "c", name: "C", supervisorId: null } } });
    const gone = makeService({
      enrolment: { class: { id: "c", name: "C", supervisorId: "t-9" } },
      supervisor: { id: "t-9", name: "Mr Departed", status: "EXITED" },
    });
    const a = await none.svc.getProfile(staff, "stu-1");
    const b = await gone.svc.getProfile(staff, "stu-1");
    expect(a).toMatchObject({ supervisor: null, supervisorLeft: false });
    expect(b).toMatchObject({ supervisor: null, supervisorLeft: true });
  });

  it("never hands back the NAME of a supervisor who has left", async () => {
    // Showing them invites somebody to contact a person who is gone.
    const { svc } = makeService({
      enrolment: { class: { id: "c", name: "C", supervisorId: "t-9" } },
      supervisor: { id: "t-9", name: "Mr Departed", status: "EXITED" },
    });
    const r = await svc.getProfile(staff, "stu-1");
    expect(JSON.stringify(r)).not.toContain("Mr Departed");
  });
});
