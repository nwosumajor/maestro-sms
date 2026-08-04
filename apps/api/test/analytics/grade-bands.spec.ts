// =============================================================================
// The dashboard's grade distribution must band on the SCHOOL'S scale
// =============================================================================
// The thresholds were written out three times — in the analytics SQL, in the
// CSV export, and in the page's own caption — and all three were wrong in the
// same way and then wrong again in a new way:
//
//   • NO E BAND. The SQL counted A>=70, B>=60, C>=50, D>=45, F<45. The real
//     default scale is A/B/C/D/E/F with E at 40. So every mark of 40-44 was
//     shown as FAILING on the dashboard while the pupil's report card graded it
//     E — a pass. That predates the configurable scale.
//   • HARD-CODED. Once a school could choose WAEC, plus-grades, Cambridge or
//     US, its dashboard described none of its report cards.
//
// Both come from the same root: knowledge duplicated instead of derived. These
// tests pin that the distribution is built from resolveGradeBands — the same
// function the report card grades on.

import { GRADE_SCALES, resolveGradeBands } from "@sms/types";

describe("the bands a dashboard must use", () => {
  it("includes E on the default scale — the band the SQL had dropped", () => {
    const grades = resolveGradeBands(null).map((b) => b.grade);
    expect(grades).toContain("E");
    expect(grades).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("puts a mark of 42 in E, not F", async () => {
    // The exact discrepancy: 40-44 was counted F on the dashboard and graded E
    // on the report card. A pass reported as a fail.
    const { gradeLetter } = await import("@sms/types");
    expect(gradeLetter(42, resolveGradeBands(null))).toBe("E");
    expect(gradeLetter(39, resolveGradeBands(null))).toBe("F");
  });

  it("gives a WAEC school its nine bands, not five", async () => {
    const bands = resolveGradeBands({ components: [], scale: "WAEC" });
    expect(bands).toHaveLength(9);
    expect(bands.map((b) => b.grade)).toContain("C6");
  });

  it("gives a US school five, with F starting at 0", async () => {
    const bands = resolveGradeBands({ components: [], scale: "US_LETTER" });
    expect(bands.map((b) => b.grade)).toEqual(["A", "B", "C", "D", "F"]);
    expect(bands[bands.length - 1].min).toBe(0);
  });

  it("bands are contiguous and descending, which is what the FILTER ranges rely on", async () => {
    // The aggregate builds each column as [min, previousMin) — that is only
    // correct if the floors strictly descend and reach 0.
    for (const [key, scale] of Object.entries(GRADE_SCALES)) {
      const b = scale.bands;
      for (let i = 1; i < b.length; i += 1) {
        expect(`${key}:${b[i].min < b[i - 1].min}`).toBe(`${key}:true`);
      }
      expect(`${key}:${b[b.length - 1].min}`).toBe(`${key}:0`);
    }
  });

  it("every band name survives being used as a SQL column alias", async () => {
    // The aggregate aliases each count by the band's own name. A name with a
    // quote in it would break the statement rather than produce a wrong number.
    for (const scale of Object.values(GRADE_SCALES)) {
      for (const b of scale.bands) {
        expect(b.grade).toMatch(/^[A-Za-z0-9*+ -]{1,4}$/);
      }
    }
  });

  it("covers every whole mark 0-100 on every scale, so no grade is uncounted", async () => {
    const { gradeLetter } = await import("@sms/types");
    for (const [key, scale] of Object.entries(GRADE_SCALES)) {
      for (let m = 0; m <= 100; m += 1) {
        const hits = scale.bands.filter((b, i) => m >= b.min && (i === 0 || m < scale.bands[i - 1].min));
        // Exactly one band claims each mark — which is what stops the dashboard
        // double-counting or dropping a pupil.
        expect(`${key}@${m}:${hits.length}`).toBe(`${key}@${m}:1`);
        expect(hits[0].grade).toBe(gradeLetter(m, scale.bands));
      }
    }
  });
});
