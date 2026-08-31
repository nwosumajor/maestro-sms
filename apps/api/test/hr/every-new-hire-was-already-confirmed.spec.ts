/**
 * EVERY MEMBER OF STAFF WAS RECORDED AS ALREADY CONFIRMED.
 *
 * `employee.confirmationStatus` DEFAULTS TO "CONFIRMED", and the only thing
 * that sets it to PROBATION is `probationMonths` on the create — a field the
 * API has always accepted and no screen ever sent. Two consequences, and the
 * second is the one that matters:
 *
 *   - the system asserted, of every new hire, that they were a confirmed
 *     member of staff. Nobody chose that; it is what a default said.
 *   - `requestEmploymentChange` refuses a CONFIRMATION for anyone not on
 *     PROBATION, so the confirmation half of the employment lifecycle —
 *     maker-checker, two people, an append-only record — was UNREACHABLE for
 *     every employee a school actually creates.
 *
 * Measured live before and after, on two real staff accounts:
 *   old way: created CONFIRMED -> "This employee is not on probation" (400)
 *   new way: created PROBATION, ends 2027-03-01 -> confirmation raised (201)
 *            -> approved by a DIFFERENT person (201) -> CONFIRMED, date cleared
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORM = readFileSync(
  join(__dirname, "..", "..", "..", "web", "components", "hr", "EmployeeForm.tsx"),
  "utf8",
);
const SERVICE = readFileSync(join(__dirname, "..", "..", "src", "hr", "hr.service.ts"), "utf8");
const EMPLOYMENT = readFileSync(join(__dirname, "..", "..", "src", "hr", "employment.service.ts"), "utf8");

describe("a school can say somebody is on probation", () => {
  it("the form sends it", () => {
    expect(FORM).toMatch(/probationMonths: Number\(probationMonths\)/);
  });

  it("OMITS it rather than sending zero", () => {
    // The service treats a number > 0 as "start a probation" and anything else
    // as "leave the status alone"; sending 0 would be a value that means
    // nothing, and a reader of the request could not tell it from a mistake.
    expect(FORM).toMatch(/\.\.\.\(probationMonths \? \{ probationMonths: Number\(probationMonths\) \} : \{\}\)/);
  });

  it("offers 'already confirmed' as the blank, which is the common case", () => {
    // Most records a school creates on day one are existing staff, and forcing
    // a probation choice on them would be a worse default than the one being
    // fixed.
    expect(FORM).toMatch(/No probation — already confirmed/);
  });

  it("says it only applies at creation, because that is true", () => {
    // The service applies it in the `create` branch of the upsert only; editing
    // an existing record cannot restart a probation, and confirming is the
    // separate two-person step.
    expect(FORM).toMatch(/Only applies when the record is first created/);
  });

  it("resets after saving, so the next hire does not inherit it", () => {
    expect(FORM).toContain('setProbationMonths("")');
  });
});

describe("what the field unlocks", () => {
  it("is the only thing that puts an employee on probation", () => {
    expect(SERVICE).toMatch(/input\.probationMonths === "number" && input\.probationMonths > 0/);
    expect(SERVICE).toContain('confirmationStatus: "PROBATION"');
  });

  it("and confirmation is refused to anyone not on it", () => {
    // The dead end: default CONFIRMED + this guard = a lifecycle stage nothing
    // could enter and nothing could leave.
    expect(EMPLOYMENT).toMatch(/type === "CONFIRMATION" && emp\.confirmationStatus !== "PROBATION"/);
  });

  it("applies at CREATE only, never on a later edit", () => {
    // Spreading probation into the update branch would let an edit silently put
    // a confirmed member of staff back on probation.
    // Bounded FORWARD from the declaration. `indexOf("await this.audit.record")`
    // finds the FIRST such call in the file, which is earlier than this — so the
    // slice came out empty and the assertion passed against nothing.
    const from = SERVICE.indexOf("const probation =");
    expect(from).toBeGreaterThan(-1);
    const upsert = SERVICE.slice(from, SERVICE.indexOf("});", SERVICE.indexOf("employee.upsert", from)));
    expect(upsert).toContain("employee.upsert");
    // The CREATE branch carries it and the UPDATE branch is `common` alone.
    expect(upsert).toMatch(/create: \{ schoolId: p\.schoolId, userId, \.\.\.common, \.\.\.probation/);
    const updateLine = upsert.split("\n").find((l) => l.includes("update:")) ?? "";
    expect(updateLine).toContain("update: common,");
    expect(updateLine).not.toContain("probation");
  });
});
