// A date window a caller typed is either a window or a refusal — never a
// silently different window. See `common/status-filter.ts` for the live
// measurements behind each case.
import { boundedInt, dateFilter, dateWindow } from "../../src/common/status-filter";

describe("dateFilter", () => {
  it("takes the date-only shape a browser date input sends", () => {
    expect(dateFilter("2026-08-26", "from")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("takes an ISO timestamp too — the shape toISOString() produces", () => {
    // The revenue ledger's regex accepted only the first shape and SILENTLY
    // DROPPED this one, returning the all-time total under an August caption.
    expect(dateFilter("2026-08-26T09:30:00Z", "from")?.toISOString()).toBe("2026-08-26T09:30:00.000Z");
    expect(dateFilter("2026-08-26T09:30:00.500+01:00", "from")?.toISOString()).toBe("2026-08-26T08:30:00.500Z");
  });

  it("snaps a DATE-ONLY end to the last millisecond, so `to` includes that day", () => {
    expect(dateFilter("2026-08-26", "to", { end: true })?.toISOString()).toBe("2026-08-26T23:59:59.999Z");
  });

  it("leaves an end the caller gave as a TIMESTAMP where they put it", () => {
    expect(dateFilter("2026-08-26T09:30:00Z", "to", { end: true })?.toISOString()).toBe("2026-08-26T09:30:00.000Z");
  });

  it("treats absent and empty as no filter, not as a refusal", () => {
    expect(dateFilter(undefined, "from")).toBeUndefined();
    expect(dateFilter("", "from")).toBeUndefined();
    expect(dateFilter("   ", "from")).toBeUndefined();
  });

  it("refuses a value it cannot read, naming both accepted shapes", () => {
    expect(() => dateFilter("abc", "from")).toThrow(/YYYY-MM-DD.*ISO 8601/);
    expect(() => dateFilter("26/08/2026", "from")).toThrow(/from must be/);
  });

  it("refuses a shape that parses but is not a real date", () => {
    // The pattern cannot see this; `new Date` yields Invalid Date, which is
    // exactly what reached Prisma as a 500 at the unguarded sites.
    expect(() => dateFilter("2026-13-45", "from")).toThrow(/not a real date/);
  });

  it("names the FIELD, so a caller with two dates knows which one is wrong", () => {
    expect(() => dateFilter("abc", "to")).toThrow(/^to must be/);
  });
});

describe("dateWindow", () => {
  it("refuses a backwards window rather than reporting an empty period", () => {
    expect(() => dateWindow("2026-08-26", "2026-08-01")).toThrow(/must not be after/);
  });

  it("allows a single-day window", () => {
    const w = dateWindow("2026-08-26", "2026-08-26");
    expect(w.from?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(w.to?.toISOString()).toBe("2026-08-26T23:59:59.999Z");
  });

  it("allows one end on its own", () => {
    expect(dateWindow("2026-08-26", undefined).to).toBeUndefined();
    expect(dateWindow(undefined, "2026-08-26").from).toBeUndefined();
  });
});

describe("boundedInt", () => {
  it("takes a whole number in range", () => {
    expect(boundedInt("50", { field: "limit" })).toBe(50);
  });

  it("refuses what `?? default` could never catch", () => {
    // NaN is not null, so the default was unreachable and NaN reached Prisma.
    expect(() => boundedInt("abc", { field: "limit" })).toThrow(/limit must be a whole number/);
    expect(() => boundedInt("1e999", { field: "limit" })).toThrow(/limit must be/);
    expect(() => boundedInt("2.5", { field: "days" })).toThrow(/days must be/);
  });

  it("refuses out of range at BOTH ends, rather than clamping a mistake", () => {
    expect(() => boundedInt("0", { field: "limit" })).toThrow(/between 1 and/);
    expect(() => boundedInt("-5", { field: "limit" })).toThrow(/between 1 and/);
    expect(() => boundedInt("2200", { field: "year", min: 1900, max: 2200 })).not.toThrow();
    expect(() => boundedInt("2201", { field: "year", min: 1900, max: 2200 })).toThrow(/between 1900 and 2200/);
  });

  it("treats absent as no answer, so the handler's own default applies", () => {
    expect(boundedInt(undefined, { field: "limit" })).toBeUndefined();
    expect(boundedInt("", { field: "limit" })).toBeUndefined();
  });
});
