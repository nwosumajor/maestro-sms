// =============================================================================
// Eight ways to hand work to a teacher who left last term
// =============================================================================
// Exiting a member of staff sets `User.status = EXITED` and deliberately leaves
// their roles and their record in place — auth's ACTIVE allowlist refuses the
// login, and the row survives for the audit. Nothing on the other side asked.
//
// `GET /users?kind=staff` — the picker behind every assignment screen — had no
// status filter at all. Live, on the demo school, with two people set EXITED:
//
//     kind=staff: 75 offered — INCLUDING headadmin@, headteacher@
//     …after both had left: 75 offered — INCLUDING headadmin@, headteacher@
//
// And the services accepted them. Each of these checks something real — the
// cover service checks self-cover and double-booking, the invigilator service
// refuses a student by role, the task service checks the school — and none of
// them checked whether the person still worked there.
//
// The duty roster is the one that got it right, resolving through
// `employee.status = "ACTIVE"`, which is what made the other seven visible.
//
// Every one is FUTURE WORK: Tuesday period 3 with a reliever who does not work
// here, an exam hall with a roster and nobody in it, a safeguarding complaint
// on an empty desk. Each also notifies an inbox its owner can no longer open,
// so the assigner is told the person has been informed.
//
// NOT touched, on purpose: reading a departed person's NAME onto a record they
// were part of — a payslip, an old audit entry, last year's report card, the
// history of a case. A leaver vanishing from their own past is a worse bug.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { assertStillHere, whoHasLeft, STILL_HERE } from "../../src/common/still-here";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

function txWith(people: Array<{ id: string; name: string; status: string }>) {
  return {
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(people.find((p) => p.id === where.id) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] }; NOT?: { status: string } } }) =>
        Promise.resolve(
          people
            .filter((p) => where.id.in.includes(p.id))
            .filter((p) => (where.NOT ? p.status !== where.NOT.status : true)),
        ),
      ),
    },
  } as unknown as TenantTx;
}

const HERE = { id: "u1", name: "Ada Obi", status: "ACTIVE" };
const GONE = { id: "u2", name: "Chike Eze", status: "EXITED" };

describe("giving work to a person", () => {
  it("is allowed when they still work here", async () => {
    await expect(assertStillHere(txWith([HERE]), "u1", "Teacher")).resolves.toEqual({
      id: "u1",
      name: "Ada Obi",
    });
  });

  it("is refused when they have left", async () => {
    await expect(assertStillHere(txWith([GONE]), "u2", "Teacher")).rejects.toThrow(BadRequestException);
  });

  it("names them, so the assigner knows why the answer is no", async () => {
    // They picked a real colleague off a real list. "Not found" would send them
    // to support to report a bug that is not one.
    await expect(assertStillHere(txWith([GONE]), "u2", "Teacher")).rejects.toThrow(
      /Chike Eze has left the school\. Pick somebody who is still here/,
    );
  });

  it("still 404s a person who is not in this school at all", async () => {
    // A DIFFERENT refusal on purpose: naming somebody would disclose that an id
    // belonging to another school exists.
    await expect(assertStillHere(txWith([HERE]), "nope", "Teacher")).rejects.toThrow(NotFoundException);
  });

  it("uses the caller's own word when the person is not there at all", async () => {
    // The 404 wording follows the screen the assigner is looking at; the "has
    // left" wording does not need it, and reading "cannot be given this user"
    // was how the hostel call site showed that up.
    await expect(assertStillHere(txWith([]), "u9", "Invigilator")).rejects.toThrow(/Invigilator not found/);
  });

  it("refuses a row carrying no status at all", async () => {
    // Every `user` row has the column. A row without one is a fixture modelling
    // something the database cannot produce, and a control that guesses ACTIVE
    // for it fails open.
    const tx = txWith([{ id: "u4", name: "No Status" } as { id: string; name: string; status: string }]);
    await expect(assertStillHere(tx, "u4", "Teacher")).rejects.toThrow(BadRequestException);
  });

  it("refuses anyone not ACTIVE, not only the EXITED", async () => {
    // DISABLED, SUSPENDED — whatever else a school does to an account, it is
    // not a person who can be handed Tuesday period 3.
    const suspended = { id: "u3", name: "Ngozi A", status: "DISABLED" };
    await expect(assertStillHere(txWith([suspended]), "u3", "Teacher")).rejects.toThrow(BadRequestException);
  });
});

describe("giving work to several people at once", () => {
  it("names everyone who has left, in one query", async () => {
    // Refusing twelve people one at a time makes somebody resubmit twelve times
    // to discover the same list.
    const tx = txWith([HERE, GONE, { id: "u3", name: "Bola A", status: "EXITED" }]);
    await expect(whoHasLeft(tx, ["u1", "u2", "u3"])).resolves.toEqual(["Chike Eze", "Bola A"]);
    expect((tx.user.findMany as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("says nothing when everybody is here", async () => {
    await expect(whoHasLeft(txWith([HERE]), ["u1"])).resolves.toEqual([]);
  });

  it("does not query at all for an empty list", async () => {
    const tx = txWith([]);
    await expect(whoHasLeft(tx, [])).resolves.toEqual([]);
    expect((tx.user.findMany as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe("the picker that offers them", () => {
  it("is the ACTIVE filter every assignment screen reads through", () => {
    // Pinned as a value because it is spread into `listUsers`'s where clause;
    // a rename there would otherwise silently drop the filter and still compile.
    expect(STILL_HERE).toEqual({ status: "ACTIVE" });
  });
});

// ---------------------------------------------------------------------------

describe("the surfaces that hand out work", () => {
  // The helper being right is worth nothing if a call site quietly stops using
  // it, and seven of these eight went years without the check. Deleting a line
  // is a one-character diff that no unit test elsewhere would notice; this
  // names the file when it happens.
  //
  // Not a substitute for the behaviour tests above — it proves the wiring, not
  // the rule. It is here because the wiring is what was missing.
  const SURFACES: Array<[string, string]> = [
    ["src/timetable/lesson-cover.service.ts", "cover reliever"],
    ["src/exam/exam.service.ts", "exam invigilator"],
    ["src/lms/lms.service.ts", "class + subject teacher, and the picker itself"],
    ["src/task/task.service.ts", "task assignee"],
    ["src/hostel/hostel.service.ts", "hostel warden and pupil placement"],
    ["src/transport/transport.service.ts", "vehicle driver"],
    ["src/discipline/discipline.service.ts", "complaint assignee"],
  ];

  it.each(SURFACES)("%s still asks whether the person is here (%s)", (file) => {
    const src = readFileSync(join(__dirname, "../..", file), "utf8");
    expect(src).toMatch(/assertStillHere|whoHasLeft|STILL_HERE/);
  });

  it("covers the picker with the same filter the services enforce", () => {
    // A list that keeps offering somebody the system will refuse is a trap
    // rather than a convenience — and it is where every one of these starts.
    const src = readFileSync(join(__dirname, "../../src/lms/lms.service.ts"), "utf8");
    expect(src).toMatch(/\.\.\.STILL_HERE,/);
  });
});
