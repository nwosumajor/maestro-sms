/**
 * The nightly sweep says "Staff document has EXPIRED" — fixed once, because the
 * notice had been in the FUTURE TENSE about a licence that had already lapsed.
 * The REGISTER a school actually reads was not fixed with it: it rendered
 * `expires {date} ({days}d)` for everything, so the same licence read
 * "expires 2024-06-01 (-823d)" in the same red as one expiring in 29 days.
 *
 * Sibling asymmetry inside one feature, with the careful half written first.
 */
import { StaffLifecycleService } from "../../src/hr/staff-lifecycle.service";
import { expiryStage } from "../../src/hr/document-expiry";

const DAY = 86_400_000;

function mapper(today: Date) {
  const s = Object.create(StaffLifecycleService.prototype) as StaffLifecycleService;
  return (expiresAt: Date | null) =>
    (s as unknown as {
      documentDto: (d: Record<string, unknown>, name: string | null, today: Date) => Record<string, unknown>;
    }).documentDto(
      { id: "d1", userId: "u1", kind: "CERTIFICATION", name: "Licence", documentId: null, expiresAt, reminderSentAt: null, createdAt: today },
      "Ada",
      today,
    );
}

const TODAY = new Date("2026-09-02T00:00:00.000Z");

describe("a lapsed certificate is not described in the future tense", () => {
  it("marks one whose day has passed as EXPIRED", () => {
    const dto = mapper(TODAY)(new Date("2024-06-01T00:00:00.000Z"));
    expect(dto.expiryStage).toBe("EXPIRED");
    // The screen keys on the STAGE, but the day count is what a reader sees
    // beside it and it must not contradict.
    expect(dto.daysUntilExpiry as number).toBeLessThan(0);
  });

  it("marks one inside the reminder window as EXPIRING, not EXPIRED", () => {
    const dto = mapper(TODAY)(new Date(TODAY.getTime() + 10 * DAY));
    expect(dto.expiryStage).toBe("EXPIRING");
  });

  it("leaves a long-dated one with no stage at all", () => {
    const dto = mapper(TODAY)(new Date(TODAY.getTime() + 400 * DAY));
    expect(dto.expiryStage).toBeNull();
  });

  it("gives a document with no expiry no stage and no day count", () => {
    const dto = mapper(TODAY)(null);
    expect(dto.expiryStage).toBeNull();
    expect(dto.daysUntilExpiry).toBeNull();
  });

  // VALID THROUGH THE DAY IT NAMES — the rule the sweep already states. A
  // certificate expiring today is still valid today.
  it("does not expire a certificate on the day it names", () => {
    expect(mapper(TODAY)(TODAY).expiryStage).not.toBe("EXPIRED");
  });

  // THE REGISTER AND THE NOTICE MUST AGREE. They are two readings of one fact,
  // and a screen that disagrees with the alert it triggers is worse than
  // either alone.
  it("gives the same answer as the sweep, for every stage", () => {
    for (const days of [-800, -1, 0, 1, 29, 30, 31, 400]) {
      const at = new Date(TODAY.getTime() + days * DAY);
      expect(mapper(TODAY)(at).expiryStage).toBe(expiryStage(at, TODAY));
    }
  });

  // THE SCHOOL'S DAY, not the server's. The sweep decides against
  // `schoolToday(tz)`; a mapper using `Date.now()` can disagree with it by a
  // day in any school not on UTC.
  it("is decided against the day it is given, not the process clock", () => {
    const at = new Date("2026-09-02T00:00:00.000Z");
    // Yesterday at the school: not yet expired.
    expect(mapper(new Date("2026-09-01T00:00:00.000Z"))(at).expiryStage).not.toBe("EXPIRED");
    // Tomorrow at the school: expired.
    expect(mapper(new Date("2026-09-03T00:00:00.000Z"))(at).expiryStage).toBe("EXPIRED");
  });
});
