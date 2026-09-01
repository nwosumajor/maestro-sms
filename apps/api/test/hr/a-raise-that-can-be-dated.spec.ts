/**
 * A raise can be dated from the product, and the screen can say so.
 *
 * `effectiveDate` has always been accepted by `POST /hr/salary/employees/:id/
 * changes`, stored on the row, and returned in `SalaryChangeDto`. The FORM never
 * sent one — so every raise raised through the product was immediate, and
 * `applyDueSalaryChanges`, which selects `effectiveDate: { not: null }`, could
 * never find a row. A migration, a nightly sweep and its tests, all for a field
 * no screen could fill in.
 *
 * The fix's own comment claimed the field was "shown on the screen" as well.
 * It was not: `SalaryChanges.tsx` did not mention it. Corrected in place — a
 * comment asserting something that was never true is the shape this repo keeps
 * finding in its own notes.
 *
 * `appliedAt` now reaches the DTO too. NULL on an APPROVED row is the state a
 * future date creates — decided, and the money has not moved — and without it a
 * screen cannot tell that from a raise already in somebody's pay.
 */
import { readFileSync } from "fs";
import { stripComments } from "../support/strip-comments";
import { join } from "path";

const FORM = stripComments(readFileSync(join(__dirname, "../../../../apps/web/components/hr/SalaryChanges.tsx"), "utf8"));
const SERVICE = stripComments(readFileSync(join(__dirname, "../../src/hr/salary.service.ts"), "utf8"));
const DTO = stripComments(readFileSync(join(__dirname, "../../../../packages/types/src/dto/hr.ts"), "utf8"));

/** The file with its comments stripped — a gate must not pass on its own prose. */
const code = (s: string) => s;

describe("a raise that can be dated", () => {
  it("the form SENDS an effective date", () => {
    const body = code(FORM);
    expect(body).toMatch(/effectiveDate:\s*effectiveDate\s*\|\|\s*null/);
  });

  it("the form has a control to set one", () => {
    expect(code(FORM)).toMatch(/id="sc-effective"[\s\S]{0,200}type="date"/);
  });

  it("the row shows when a change takes effect", () => {
    expect(code(FORM)).toMatch(/c\.effectiveDate\s*\?/);
  });

  it("an APPROVED change says whether it is in force yet", () => {
    // "Approved" alone cannot distinguish a raise already being paid from one
    // that starts in October.
    const body = code(FORM);
    expect(body).toMatch(/c\.appliedAt/);
    expect(body).toMatch(/not yet in force/);
  });

  it("appliedAt is on the DTO, so the screen can be told", () => {
    expect(code(DTO)).toMatch(/appliedAt:\s*Date \| null/);
  });

  it("the service maps appliedAt rather than dropping it", () => {
    expect(code(SERVICE)).toMatch(/appliedAt:\s*r\.appliedAt/);
  });

  it("the salary label follows the school's currency, not a naira sign", () => {
    // The figures already used the school-aware `money` from useFormat; the
    // LABEL said (₦) whatever the school bills in.
    expect(FORM).not.toContain("New salary (₦)");
    expect(code(FORM)).toMatch(/New salary \(\{region\.currency\}\)/);
  });

  it("the sweep still only claims rows that carry a date", () => {
    // The other half of the same feature: without this filter the sweep would
    // re-apply every approved change in the school's history on its first run.
    const sweep = stripComments(readFileSync(join(__dirname, "../../src/hr/staff-reminder.service.ts"), "utf8"));
    expect(code(sweep)).toMatch(/effectiveDate:\s*\{\s*not:\s*null/);
  });
});
