import { formatAdmissionNumber, nextAdmissionSeq, ADMISSION_NUMBER_RE } from "@sms/types";

describe("admission number", () => {
  it("formats as <year>/NNNN, zero-padded", () => {
    expect(formatAdmissionNumber(2026, 1)).toBe("2026/0001");
    expect(formatAdmissionNumber(2026, 42)).toBe("2026/0042");
    expect(formatAdmissionNumber(2026, 12345)).toBe("2026/12345");
  });

  it("nextAdmissionSeq is 1 on an empty school", () => {
    expect(nextAdmissionSeq([], 2026)).toBe(1);
  });

  it("continues after the highest existing sequence FOR THAT YEAR", () => {
    expect(nextAdmissionSeq(["2026/0001", "2026/0007", "2026/0003"], 2026)).toBe(8);
  });

  it("ignores other years and a school's own custom formats", () => {
    expect(nextAdmissionSeq(["2025/0099", "STA-12", "random"], 2026)).toBe(1);
    expect(nextAdmissionSeq(["2026/0005", "2025/9999"], 2026)).toBe(6);
  });

  it("the regex only matches the generated shape", () => {
    expect(ADMISSION_NUMBER_RE.test("2026/0001")).toBe(true);
    expect(ADMISSION_NUMBER_RE.test("STA-12")).toBe(false);
  });
});
