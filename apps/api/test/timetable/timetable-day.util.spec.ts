// =============================================================================
// Timetable day structure — pure generator + validator
// =============================================================================

import { generateDayStructure, validateDayStructure, MAX_DAY_SLOTS } from "@sms/types";

const base = { teachingPeriods: 8, dayStart: "08:00", periodMinutes: 40, breaks: [] as { afterPeriod: number; minutes: number; name?: string }[] };

describe("validateDayStructure", () => {
  it("accepts a plain valid day", () => {
    expect(validateDayStructure(base)).toBeNull();
  });

  it("rejects zero teaching periods", () => {
    expect(validateDayStructure({ ...base, teachingPeriods: 0 })).toMatch(/at least one teaching period/i);
  });

  it("rejects a bad start time", () => {
    expect(validateDayStructure({ ...base, dayStart: "25:00" })).toMatch(/valid HH:MM/i);
  });

  it("rejects a break after the LAST period", () => {
    expect(validateDayStructure({ ...base, teachingPeriods: 5, breaks: [{ afterPeriod: 5, minutes: 20 }] })).toMatch(/not after the last/i);
  });

  it("rejects two breaks after the same period", () => {
    expect(validateDayStructure({ ...base, breaks: [{ afterPeriod: 2, minutes: 20 }, { afterPeriod: 2, minutes: 30 }] })).toMatch(/both fall after period 2/i);
  });

  it("rejects a day that runs past midnight", () => {
    expect(validateDayStructure({ teachingPeriods: 20, dayStart: "22:00", periodMinutes: 60, breaks: [] })).toMatch(/past midnight/i);
  });

  it("rejects more than the slot ceiling", () => {
    expect(validateDayStructure({ ...base, teachingPeriods: MAX_DAY_SLOTS, breaks: [{ afterPeriod: 1, minutes: 10 }] })).toMatch(/maximum is/i);
  });
});

describe("generateDayStructure", () => {
  it("interleaves breaks and computes sequential clock times", () => {
    const day = generateDayStructure({
      teachingPeriods: 4,
      dayStart: "08:00",
      periodMinutes: 40,
      breaks: [{ afterPeriod: 2, minutes: 20, name: "Short Break" }],
    });
    // P1, P2, Break, P3, P4 — five slots, sequence 1..5.
    expect(day.map((d) => d.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(day.map((d) => d.isBreak)).toEqual([false, false, true, false, false]);
    expect(day.map((d) => d.name)).toEqual(["Period 1", "Period 2", "Short Break", "Period 3", "Period 4"]);
    // Times: 08:00-08:40, 08:40-09:20, [break 09:20-09:40], 09:40-10:20, 10:20-11:00.
    expect(day.map((d) => `${d.startTime}-${d.endTime}`)).toEqual([
      "08:00-08:40", "08:40-09:20", "09:20-09:40", "09:40-10:20", "10:20-11:00",
    ]);
  });

  it("teaching-period names count teaching slots only, sequence counts everything", () => {
    const day = generateDayStructure({ teachingPeriods: 3, dayStart: "09:00", periodMinutes: 30, breaks: [{ afterPeriod: 1, minutes: 15 }] });
    // "Period 2" is the 3rd slot (after the break) — its name is teaching-index 2, its sequence is 3.
    const p2 = day.find((d) => d.name === "Period 2");
    expect(p2?.sequence).toBe(3);
    expect(day.find((d) => d.isBreak)?.name).toBe("Break"); // default label
  });
});
