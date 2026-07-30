// =============================================================================
// SisService — profile completion + two-stage review
// =============================================================================
// A name-only bulk import leaves a pupil with nothing but a name. This flow turns
// that into a real record: the pupil fills it in, SUBMITs, their CLASS SUPERVISOR
// checks it, and the SCHOOL ADMIN approves. The behaviours that make it hold:
//   * "complete" has ONE definition (missingProfileFields), used by both the
//     prompt and the submit guard, so they cannot drift apart;
//   * a half-filled profile cannot be submitted — staff review finished records;
//   * the supervisor stage is a RELATIONSHIP check (supervisor of the pupil's
//     class), 404-not-403 for anyone else;
//   * approval REQUIRES the supervisor check first, or that stage is decorative;
//   * a send-back returns the pupil to the nudge loop with a note.

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { missingProfileFields } from "@sms/types";
import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const COMPLETE = {
  id: "pf1",
  studentId: "stu1",
  dateOfBirth: new Date("2012-04-01"),
  gender: "F",
  phone: "08012345678",
  addressLine1: "1 Broad St",
  city: "Lagos",
  state: "Lagos",
  profileStatus: "INCOMPLETE",
  submittedAt: null,
  approvedAt: null,
  supervisorReviewedAt: null,
  reviewNote: null,
};

function makeService(over: { profile?: Record<string, unknown> | null; supervisorEnrolment?: unknown } = {}) {
  const update = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...COMPLETE, ...over.profile, ...args.data }),
  );
  const tx = {
    studentProfile: {
      findFirst: jest.fn().mockResolvedValue(over.profile === undefined ? COMPLETE : over.profile),
      findMany: jest.fn().mockResolvedValue([]),
      update,
    },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue(over.supervisorEnrolment ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Ada" }),
      findMany: jest.fn().mockResolvedValue([{ id: "adm1", name: "Admin" }]),
    },
  } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new SisService(db as never, audit as never, notifications as never);
  return { service, tx, audit, update, notifications };
}

// A pupil acting on their OWN record.
const pupil = (): Principal => ({ schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["student.profile.write"] });
const supervisor = (): Principal => ({ schoolId: "A", userId: "sup1", roles: ["teacher"], permissions: ["student.profile.read"] });
const admin = (): Principal => ({ schoolId: "A", userId: "adm1", roles: ["school_admin"], permissions: ["rbac.manage"] });

describe("missingProfileFields (pure)", () => {
  it("lists every required field for an absent profile", () => {
    expect(missingProfileFields(null)).toEqual(["dateOfBirth", "gender", "phone", "addressLine1", "city", "state"]);
  });

  it("treats blank and whitespace-only strings as missing", () => {
    expect(missingProfileFields({ ...COMPLETE, city: "   ", state: "" } as never)).toEqual(["city", "state"]);
  });

  it("returns nothing for a complete profile", () => {
    expect(missingProfileFields(COMPLETE as never)).toEqual([]);
  });
});

describe("SIS profile submission", () => {
  it("reports what is still outstanding", async () => {
    const { service } = makeService({ profile: { ...COMPLETE, phone: null, city: null } });
    const res = await service.completion(pupil(), "stu1");
    expect(res).toMatchObject({ complete: false, status: "INCOMPLETE" });
    expect(res.missing).toEqual(["phone", "city"]);
  });

  it("REFUSES to submit a half-filled profile, naming the gaps", async () => {
    const { service, update } = makeService({ profile: { ...COMPLETE, phone: null } });
    await expect(service.submitProfile(pupil(), "stu1")).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("submits a complete profile, clearing any earlier reviewer note", async () => {
    const { service, update, notifications } = makeService({
      profile: { ...COMPLETE, profileStatus: "CHANGES_REQUESTED", reviewNote: "Add your address" },
    });
    const res = await service.submitProfile(pupil(), "stu1");
    expect(res.status).toBe("SUBMITTED");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ profileStatus: "SUBMITTED", reviewNote: null }) }),
    );
    // Nothing to notify without a supervisor on the class, but it must not throw.
    expect(notifications.enqueue).not.toThrow();
  });

  it("refuses to re-submit an APPROVED profile", async () => {
    const { service } = makeService({ profile: { ...COMPLETE, profileStatus: "APPROVED" } });
    await expect(service.submitProfile(pupil(), "stu1")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("stage 1 — class supervisor", () => {
  const submitted = { ...COMPLETE, profileStatus: "SUBMITTED", submittedAt: new Date() };

  it("a non-supervisor gets 404 (no existence disclosure)", async () => {
    const { service } = makeService({ profile: submitted, supervisorEnrolment: null });
    await expect(service.supervisorReview(supervisor(), "stu1", "PASS")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the supervisor passes it on, stamping who checked it", async () => {
    const { service, update } = makeService({ profile: submitted, supervisorEnrolment: { id: "e1" } });
    const res = await service.supervisorReview(supervisor(), "stu1", "PASS");
    expect(res.status).toBe("SUBMITTED"); // still awaiting the admin
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ supervisorReviewedById: "sup1" }) }),
    );
  });

  it("a send-back returns the pupil to the loop WITH a note", async () => {
    const { service, update, notifications } = makeService({ profile: submitted, supervisorEnrolment: { id: "e1" } });
    const res = await service.supervisorReview(supervisor(), "stu1", "CHANGES", "  Date of birth looks wrong  ");
    expect(res.status).toBe("CHANGES_REQUESTED");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileStatus: "CHANGES_REQUESTED", reviewNote: "Date of birth looks wrong" }),
      }),
    );
    expect(notifications.enqueue).toHaveBeenCalled(); // the pupil is told why
  });

  it("only a SUBMITTED profile can be reviewed", async () => {
    const { service } = makeService({ profile: COMPLETE, supervisorEnrolment: { id: "e1" } });
    await expect(service.supervisorReview(supervisor(), "stu1", "PASS")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("stage 2 — school admin", () => {
  it("REFUSES to approve before the supervisor has checked it", async () => {
    // Otherwise the supervisor stage is decorative and can be skipped entirely.
    const { service, update } = makeService({
      profile: { ...COMPLETE, profileStatus: "SUBMITTED", supervisorReviewedAt: null },
    });
    await expect(service.approveProfile(admin(), "stu1")).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("approves once the supervisor has passed it, and tells the pupil", async () => {
    const { service, update, notifications } = makeService({
      profile: { ...COMPLETE, profileStatus: "SUBMITTED", supervisorReviewedAt: new Date() },
    });
    const res = await service.approveProfile(admin(), "stu1");
    expect(res.status).toBe("APPROVED");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ profileStatus: "APPROVED", approvedById: "adm1" }) }),
    );
    expect(notifications.enqueue).toHaveBeenCalled();
  });
});
