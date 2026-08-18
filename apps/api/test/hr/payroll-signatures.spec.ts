// =============================================================================
// Payroll is maker-checker and named neither person
// =============================================================================
// Swept for the column-level version of #260 — a field written and never read —
// by listing scalar columns mentioned at most once in all source. Sixteen came
// back, nearly all `…ById` / `…At` accountability fields. This is the one that
// matters most, because it is the largest money movement a school makes.
//
// Finalising a payroll run is maker-checker: `finalize()` refuses
// `run.runById === p.userId`. Both halves are recorded — `runById` at creation,
// `finalizedById` at finalisation. `PayrollRunDto` exposed `createdAt` and
// `finalizedAt` and NEITHER name, so a school could see WHEN a run was raised
// and WHEN it was signed off, and never by whom. `finalizedById` was written by
// one line and read by nothing at all.
//
// Sibling asymmetry is what makes it a defect rather than a choice — every
// other control of this kind names both people:
//
//   InvoiceAdjustmentDto   requestedById  + approvedById
//   StaffLoanDto           requestedById  + decidedById + decidedAt
//   StaffExitDto           initiatedById  + decidedById + decidedAt
//   PayrollRunDto          — neither —
//
// NAMES, not bare ids: the siblings expose ids and no screen renders them,
// which is a record that exists and still cannot be read. The point of exposing
// this is that somebody sees it.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(join(__dirname, "../../src/hr/payroll.service.ts"), "utf8");
const CODE = SERVICE.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const DTO = readFileSync(join(__dirname, "../../../../packages/types/src/dto/hr.ts"), "utf8");
const WEB = readFileSync(
  join(__dirname, "../../../web/components/hr/PayrollManager.tsx"),
  "utf8",
);

describe("the two signatures on a run", () => {
  it("are both in the DTO", () => {
    const at = DTO.indexOf("interface PayrollRunDto");
    const body = DTO.slice(at, DTO.indexOf("}", at));
    for (const f of ["runById", "runByName", "finalizedById", "finalizedByName"]) {
      expect([f, body.includes(f)]).toEqual([f, true]);
    }
  });

  it("are resolved to names, not left as ids nobody renders", () => {
    expect(CODE).toMatch(/runByName: nameOf\?\.get\(r\.runById\)/);
    expect(CODE).toMatch(/finalizedByName: r\.finalizedById \? nameOf\?\.get\(r\.finalizedById\)/);
  });

  it("are looked up ONCE for a page of runs, not once per run", () => {
    expect(CODE).toMatch(/const nameOf = await this\.signatories\(tx, runs\)/);
    expect(CODE).toMatch(/where: \{ id: \{ in: ids \} \}/);
  });

  it("leave finalizedByName null while a run is still DRAFT", () => {
    // A draft has one signature, and claiming two would be worse than showing
    // none.
    expect(CODE).toMatch(/r\.finalizedById \? nameOf\?\.get\(r\.finalizedById\) \?\? "Unknown" : null/);
  });

  it("are shown on the payroll screen", () => {
    expect(WEB).toMatch(/raised by \{r\.runByName\}/);
    expect(WEB).toMatch(/finalised by \$\{r\.finalizedByName\}/);
  });
});

describe("what must not have changed", () => {
  it("still refuses a finaliser who raised the run", () => {
    expect(CODE).toMatch(/run\.runById === p\.userId/);
  });

  it("still records who finalised it", () => {
    expect(CODE).toMatch(/finalizedById: p\.userId/);
  });
});

describe("the siblings this was measured against", () => {
  it.each([
    ["InvoiceAdjustmentDto", "fees.ts", ["requestedById", "approvedById"]],
    ["StaffLoanDto", "hr.ts", ["requestedById", "decidedById"]],
    ["StaffExitDto", "hr.ts", ["initiatedById", "decidedById"]],
  ])("%s still names both people", (name, file, fields) => {
    // If one of these ever loses its approver field, the same blind spot is
    // back somewhere else.
    const src = readFileSync(
      join(__dirname, "../../../../packages/types/src/dto", file),
      "utf8",
    );
    const at = src.indexOf(`interface ${name}`);
    const body = src.slice(at, src.indexOf("}", at));
    for (const f of fields) expect([name, f, body.includes(f)]).toEqual([name, f, true]);
  });
});
