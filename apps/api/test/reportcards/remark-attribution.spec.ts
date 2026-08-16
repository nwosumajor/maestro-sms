// =============================================================================
// A comment about a child belongs to whoever made it
// =============================================================================
// `report_card_remark` has carried `classTeacherId` and `headId` since the table
// was created — the model comment even says the remark is "stamped with the
// writer's id". Every reader threw them away: `remarksForPdf` returned two
// strings, the DTO returned two strings, and the printed card said
// "Class teacher: ..." with no name against it.
//
// That is not a cosmetic gap. A report card is a document a family keeps and may
// argue with, and an unattributed remark reads as the school speaking
// collectively about something one teacher wrote. The signature block is the
// part of the printed format that makes a judgement answerable.
//
// The HEAD remark is staff-wide, so its author may be the principal or a school
// administrator — and the printed label follows the author rather than being
// fixed, because "Principal's comments" over an administrator's words is a small
// lie on a document nobody will ever correct.
// =============================================================================

import { ReportCardRemarkService } from "../../src/reportcards/report-card-remark.service";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

type Row = {
  classTeacherRemark: string | null;
  classTeacherId: string | null;
  headRemark: string | null;
  headId: string | null;
};

function makeTx(row: Row | null, people: Array<{ id: string; name: string; roles: string[] }>) {
  const findMany = jest.fn(async (a: { where: { id: { in: string[] } } }) =>
    people
      .filter((u) => a.where.id.in.includes(u.id))
      .map((u) => ({ id: u.id, name: u.name, roles: u.roles.map((r) => ({ role: { name: r } })) })),
  );
  return {
    tx: { reportCardRemark: { findFirst: jest.fn(async () => row) }, user: { findMany } } as unknown as TenantTx,
    findMany,
  };
}

const service = () => new ReportCardRemarkService(null as never, null as never);

const PEOPLE = [
  { id: "t1", name: "Mrs H. Rahman", roles: ["teacher"] },
  { id: "p1", name: "Dr A. Bello", roles: ["principal"] },
  { id: "a1", name: "Mr Okoro", roles: ["school_admin"] },
];

describe("remarksForPdf", () => {
  it("names the teacher who wrote the class-teacher remark", async () => {
    const { tx } = makeTx(
      { classTeacherRemark: "Applies critical thinking.", classTeacherId: "t1", headRemark: null, headId: null },
      PEOPLE,
    );
    const out = await service().remarksForPdf(tx, "s1", "term1");
    expect(out.classTeacher).toEqual({ text: "Applies critical thinking.", byName: "Mrs H. Rahman" });
    expect(out.head).toBeNull();
  });

  it("labels a principal's remark as the principal's", async () => {
    const { tx } = makeTx(
      { classTeacherRemark: null, classTeacherId: null, headRemark: "Keep it up.", headId: "p1" },
      PEOPLE,
    );
    const out = await service().remarksForPdf(tx, "s1", "term1");
    expect(out.head).toEqual({ text: "Keep it up.", byName: "Dr A. Bello", label: "Principal's comments" });
  });

  it("labels a school administrator's remark as the head teacher's", async () => {
    const { tx } = makeTx(
      { classTeacherRemark: null, classTeacherId: null, headRemark: "Noted.", headId: "a1" },
      PEOPLE,
    );
    const out = await service().remarksForPdf(tx, "s1", "term1");
    expect(out.head?.label).toBe("Head teacher's comments");
    expect(out.head?.byName).toBe("Mr Okoro");
  });

  it("still returns the remark when its author has left the school", async () => {
    // A departed teacher's remark must not vanish from a card that was written
    // while they were there. The name is what is missing, not the comment.
    const { tx } = makeTx(
      { classTeacherRemark: "A steady term.", classTeacherId: "gone", headRemark: null, headId: null },
      PEOPLE,
    );
    const out = await service().remarksForPdf(tx, "s1", "term1");
    expect(out.classTeacher).toEqual({ text: "A steady term.", byName: null });
  });

  it("asks for no names when there are no remarks", async () => {
    const { tx, findMany } = makeTx(
      { classTeacherRemark: null, classTeacherId: "t1", headRemark: null, headId: "p1" },
      PEOPLE,
    );
    // An id left over from a remark that was later cleared must not cause a
    // lookup, nor a name printed against nothing.
    const out = await service().remarksForPdf(tx, "s1", "term1");
    expect(findMany).not.toHaveBeenCalled();
    expect(out).toEqual({ classTeacher: null, head: null });
  });

  it("returns both as null when no remark row exists at all", async () => {
    const { tx } = makeTx(null, PEOPLE);
    expect(await service().remarksForPdf(tx, "s1", "term1")).toEqual({ classTeacher: null, head: null });
  });

  it("looks the authors up in ONE query", async () => {
    const { tx, findMany } = makeTx(
      { classTeacherRemark: "A.", classTeacherId: "t1", headRemark: "B.", headId: "p1" },
      PEOPLE,
    );
    await service().remarksForPdf(tx, "s1", "term1");
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
