// =============================================================================
// A complaint was filed and nobody was told
// =============================================================================
// Every other step of this pipeline notifies the person it depends on: assigning
// a case tells the assignee, recording an outcome tells the family. Filing —
// the step that starts it — wrote a row and alerted no one, so a pupil reporting
// that they were being bullied, or a parent reporting a member of staff,
// produced a record that was only ever seen if somebody happened to open the
// discipline list and look.
//
// WHO IS TOLD is the whole design. Not every discipline.manage holder: a teacher
// holds it too, and alerting sixty of them on every complaint is noise that gets
// muted — and on a STAFF case it would be a disclosure to the accused's
// colleagues. Leadership triages and assigns; assignment already reaches the
// individual.
//
// // SECURITY: and never the person the case is ABOUT. A complaint is invisible
// // to them by the read rule (visibleComplaintWhere), so announcing it to them
// // would leak through the notification what the query is careful to hide.
// // Filing a complaint about the principal must not notify the principal.
// =============================================================================

import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PARENT: Principal = { schoolId: "A", userId: "parent-1", roles: ["parent"], permissions: ["discipline.file"] };
const ACCUSED = "teacher-9";

function make(leadership: string[] = ["principal-1", "admin-1"]) {
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: ACCUSED }) },
    disciplineComplaint: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "case-1" }),
    },
    userRole: { findMany: jest.fn().mockResolvedValue(leadership.map((userId) => ({ userId }))) },
  } as unknown as TenantTx;
  const s = Object.create(DisciplineService.prototype) as DisciplineService;
  Object.assign(s, {
    db: {
      runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
    },
    audit: { record: jest.fn() },
    notifications: { enqueueMany },
    logger: { warn: jest.fn() },
  });
  (s as unknown as { log: unknown }).log = jest.fn();
  return { s, tx, enqueueMany };
}

describe("filing a case", () => {
  it("tells leadership it is waiting", async () => {
    const { s, enqueueMany } = make();
    await s.fileAboutVisibleContent(PARENT, {
      subject: "Reported post", details: "d", againstId: ACCUSED, againstType: "TEACHER",
    });
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect(enqueueMany.mock.calls[0][1]).toEqual(["principal-1", "admin-1"]);
  });

  it("asks only for the roles that can act on every case", async () => {
    const { s, tx } = make();
    await s.fileAboutVisibleContent(PARENT, {
      subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER",
    });
    expect(tx.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: { name: { in: ["principal", "school_admin"] } } } }),
    );
  });

  it("NEVER tells the person the case is about", async () => {
    // The accused is a school_admin here, so they come back in the recipient
    // query and must be filtered out of it.
    const { s, enqueueMany } = make(["principal-1", ACCUSED]);
    await s.fileAboutVisibleContent(PARENT, {
      subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER",
    });
    expect(enqueueMany.mock.calls[0][1]).toEqual(["principal-1"]);
  });

  it("does not tell the person who filed it", async () => {
    const filer: Principal = { ...PARENT, userId: "principal-1" };
    const { s, enqueueMany } = make(["principal-1", "admin-1"]);
    await s.fileAboutVisibleContent(filer, {
      subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER",
    });
    expect(enqueueMany.mock.calls[0][1]).toEqual(["admin-1"]);
  });

  it("says nothing about the substance — these are records about children", async () => {
    const { s, enqueueMany } = make();
    await s.fileAboutVisibleContent(PARENT, {
      subject: "Reported post in Year 9", details: "he said something horrible about my daughter",
      againstId: ACCUSED, againstType: "TEACHER",
    });
    const msg = JSON.stringify(enqueueMany.mock.calls[0][2]);
    expect(msg).not.toContain("horrible");
    expect(msg).not.toContain("Year 9");
    expect(msg).toContain("case-1"); // a pointer to the case, and nothing else
  });

  it("stays silent when there is nobody to tell, rather than throwing", async () => {
    const { s, enqueueMany } = make([]);
    await expect(
      s.fileAboutVisibleContent(PARENT, { subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER" }),
    ).resolves.toEqual({ id: "case-1", alreadyOpen: false });
    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it("files the case even if telling anybody fails", async () => {
    // The case is already real. A notification that cannot be sent must not undo
    // it — the same rule assign() follows.
    const { s, enqueueMany } = make();
    enqueueMany.mockRejectedValue(new Error("queue down"));
    await expect(
      s.fileAboutVisibleContent(PARENT, { subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER" }),
    ).resolves.toEqual({ id: "case-1", alreadyOpen: false });
  });
});

describe("a repeat report", () => {
  it("returns the open case instead of filing a second one", async () => {
    const { s, tx, enqueueMany } = make();
    (tx.disciplineComplaint.findFirst as jest.Mock).mockResolvedValue({ id: "case-existing" });
    await expect(
      s.fileAboutVisibleContent(PARENT, { subject: "s", details: "d", againstId: ACCUSED, againstType: "TEACHER" }),
    ).resolves.toEqual({ id: "case-existing", alreadyOpen: true });
    expect(tx.disciplineComplaint.create).not.toHaveBeenCalled();
    // And does not re-alert: the case is already on leadership's list.
    expect(enqueueMany).not.toHaveBeenCalled();
  });
});
