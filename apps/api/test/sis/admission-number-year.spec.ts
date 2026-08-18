// =============================================================================
// An admission number carries the SCHOOL's year
// =============================================================================
// Both the manual and the bulk path stamped `new Date().getFullYear()` — the
// server's year, which in a container is UTC. The number is a printed
// identifier: it goes on the ID card and is what a clerk searches by, so a wrong
// year is a permanent mislabelling of a pupil rather than a display quirk.
//
// It was wrong at both ends of the map. A pupil enrolled at 20:00 on 31 December
// in Toronto (UTC-4) is already 1 January in UTC and was stamped with the NEXT
// year. One enrolled at 07:00 on 1 January in Singapore (UTC+8) is still
// 31 December in UTC and was stamped with the LAST. January opens the academic
// year for six of the catalogued countries, so this is not a quiet week.
// =============================================================================

import { schoolAdmissionYear } from "../../src/foundation/admission-number";

function txFor(school: { country?: string | null; timezone?: string | null } | null) {
  return { school: { findFirst: () => Promise.resolve(school) } } as never;
}

describe("which year a new admission number belongs to", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("is still last year on New Year's Eve in Toronto", async () => {
    // 2027-01-01T01:00Z is 2026-12-31 20:00 in Toronto.
    jest.setSystemTime(new Date("2027-01-01T01:00:00.000Z"));
    expect(await schoolAdmissionYear(txFor({ country: "CA", timezone: "America/Toronto" }), "s")).toBe(2026);
    // The contrast, stated WITHOUT reference to the runner's own clock: at the
    // same instant a school on UTC is already in the new year. Asserting
    // `new Date().getFullYear()` instead made the test depend on the machine's
    // timezone — it passed here (UTC+1) and would fail west of Greenwich, which
    // is the very confusion being fixed.
    expect(await schoolAdmissionYear(txFor({ country: "GH", timezone: "Africa/Accra" }), "s")).toBe(2027);
  });

  it("is already the new year on New Year's morning in Singapore", async () => {
    // 2026-12-31T23:00Z is 2027-01-01 07:00 in Singapore.
    jest.setSystemTime(new Date("2026-12-31T23:00:00.000Z"));
    expect(await schoolAdmissionYear(txFor({ country: "SG", timezone: "Asia/Singapore" }), "s")).toBe(2027);
    // And a school on UTC is still in the old one at that same instant.
    expect(await schoolAdmissionYear(txFor({ country: "GH", timezone: "Africa/Accra" }), "s")).toBe(2026);
  });

  it("agrees with the server when the school is on UTC", async () => {
    jest.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    expect(await schoolAdmissionYear(txFor({ country: "GH", timezone: "Africa/Accra" }), "s")).toBe(2026);
  });

  it("treats a school with no region as the platform's home country", async () => {
    // Null means the platform's country, not "unknown" — schools that predate
    // the region model must keep behaving exactly as they did.
    jest.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    expect(await schoolAdmissionYear(txFor({ country: null, timezone: null }), "s")).toBe(2026);
    expect(await schoolAdmissionYear(txFor(null), "s")).toBe(2026);
  });
});
