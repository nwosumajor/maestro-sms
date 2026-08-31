import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAYROLL_PACKS,
  REMITTANCE_KEYS,
  computeMonthlyPayslip,
  employerPensionMinor,
  remittanceSchedulesFor,
} from "@sms/types";

/**
 * `payroll.ts` opens with the rule: a country either has a PACK or payroll
 * REFUSES to run, because "a payslip that is confidently wrong about tax is
 * worse than no payslip — it is a filing a school hands to an employee and to
 * a revenue authority."
 *
 * The REMITTANCE SCHEDULE *is* the filing, and it was never packed. Every
 * country got Nigeria's three: a PAYE column headed "TIN", a pension schedule
 * keyed on an "RSA PIN" with the employer share at Nigeria's 10%, and the
 * National Housing Fund — while National Insurance, which every UK payslip
 * this platform produces already computes, had no schedule at all.
 */

const src = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SERVICE = src("apps", "api", "src", "hr", "payroll.service.ts");
const MANAGER = src("apps", "web", "components", "hr", "PayrollManager.tsx");

describe("every pack declares the filings its country actually makes", () => {
  it("names schedules for every implemented pack", () => {
    const packs = Object.keys(PAYROLL_PACKS);
    expect(packs.length).toBeGreaterThan(1);
    for (const key of packs) {
      const schedules = remittanceSchedulesFor(key);
      expect(schedules.length).toBeGreaterThan(0);
      for (const s of schedules) expect(REMITTANCE_KEYS).toContain(s.key);
    }
  });

  it("gives Nigeria exactly what it had — the only live pack must not move", () => {
    expect(remittanceSchedulesFor("NG").map((r) => r.key)).toEqual(["paye", "pension", "nhf"]);
    expect(remittanceSchedulesFor("NG").find((r) => r.key === "paye")?.identifierLabel).toBe("TIN");
    expect(remittanceSchedulesFor("NG").find((r) => r.key === "pension")?.identifierLabel).toBe("RSA PIN");
  });

  it("does not offer Nigeria's instruments to another country", () => {
    // A TIN, an RSA PIN and the National Housing Fund are Nigerian. Heading a
    // British filing with them names a number the employer does not have.
    const gb = remittanceSchedulesFor("GB");
    expect(gb.map((r) => r.key)).not.toContain("nhf");
    for (const s of gb) {
      expect(s.identifierLabel).not.toMatch(/TIN|RSA/);
    }
  });

  it("files National Insurance where the country's payslips compute it", () => {
    // The gap that made this more than tidiness: NI is on every UK breakdown
    // and no schedule read it, so it could not be filed at all.
    const uk = computeMonthlyPayslip(400_000_00, "GB", new Date("2026-06-30"));
    expect(uk.niMinor ?? 0).toBeGreaterThan(0);
    expect(remittanceSchedulesFor("GB").map((r) => r.key)).toContain("ni");
  });

  it("states an employer contribution only where the country fixes one", () => {
    // Nigeria fixes 10% in law. UK auto-enrolment fixes a MINIMUM a scheme may
    // exceed, so there is no figure this platform holds — and Nigeria's 10% on
    // a British pension filing is the confidently-wrong number the module
    // exists to refuse.
    expect(remittanceSchedulesFor("NG").find((r) => r.key === "pension")?.employerRate).toBe(0.1);
    expect(remittanceSchedulesFor("GB").find((r) => r.key === "pension")?.employerRate).toBeNull();
  });

  it("takes the employer rate as an argument, never a hidden constant", () => {
    expect(employerPensionMinor(20_000_000, 0.1)).toBe(2_000_000);
    expect(employerPensionMinor(20_000_000, 0.03)).toBe(600_000);
  });
});

describe("the export refuses what the country does not file", () => {
  it("resolves the school's own schedules before doing anything else", () => {
    expect(SERVICE).toMatch(/remittanceSchedulesFor\(region\.payrollPack\)/);
    expect(SERVICE).toMatch(/const schedule = schedules\.find\(\(r\) => r\.key === type\)/);
    expect(SERVICE).toMatch(/if \(!schedule\) \{[\s\S]{0,400}?BadRequestException/);
  });

  it("names what IS available rather than only what is not", () => {
    expect(SERVICE).toMatch(/schedules\.map\(\(r\) => r\.label\)\.join\(", "\)/);
  });

  it("takes the identifier column and the employer rate from the schedule", () => {
    expect(SERVICE).toMatch(/csvCell\(schedule\.identifierLabel\)/);
    expect(SERVICE).toMatch(/schedule\.employerRate == null \? null : employerPensionMinor\(/);
    // The employer columns disappear entirely when there is no rate — an empty
    // column headed "Employer 10%" would be the same wrong claim, blank.
    expect(SERVICE).toMatch(/employer == null \? \[\] : \[/);
    expect(SERVICE).not.toMatch(/"Employer 10% \(/);
  });
});

describe("the page offers the school's own filings", () => {
  it("renders them from the country's schedules, not three fixed links", () => {
    expect(MANAGER).toMatch(/schedules\.map\(\(sch\) => \(/);
    expect(MANAGER).toMatch(/remittance\?type=\$\{sch\.key\}/);
  });

  it("no longer hard-codes Nigeria's three", () => {
    expect(MANAGER).not.toMatch(/remittance\?type=paye/);
    expect(MANAGER).not.toMatch(/>NHF</);
  });
});
