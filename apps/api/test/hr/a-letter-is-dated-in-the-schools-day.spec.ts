// =============================================================================
// The school's calendar day, on the two surfaces that still used the server's
// =============================================================================
// An earlier sweep moved "today" onto the school's day across the register, the
// gate scan, the term lock and the rest, and recorded that the remaining
// `toISOString()` uses "label a document; they do not key a record".
//
// That is the right test for a CSV filename and the wrong one for both of these:
//
//  - `LetterService` prints `Date:` on an official letter that says "They remain
//    in our employment AS AT THE DATE OF THIS LETTER", handed to banks and
//    embassies. The date is the CONTENT, not a label. In UTC a letter issued at
//    07:00 in Singapore is dated YESTERDAY; one issued at 21:00 in Toronto is
//    dated TOMORROW.
//
//  - `TimetableService.deleteEntry` did not label anything at all. It FILTERED
//    which relievers get told their duty was withdrawn, on
//    `new Date(new Date().toISOString().slice(0, 10))` — while every other cover
//    read resolves the school's timezone. East of UTC that includes yesterday,
//    so deleting a lesson told a teacher a lesson they had already taught was
//    cancelled: the exact noise the "only future cover is announced" rule exists
//    to prevent.
// =============================================================================

import { inflateSync } from "node:zlib";
import { schoolToday } from "@sms/types";
import { LetterService } from "../../src/hr/letter.service";

describe("a day is the school's day, east and west of UTC", () => {
  // 07:00 on the 27th in Singapore is still the 26th in UTC.
  const singaporeMorning = new Date("2026-08-26T23:00:00.000Z");
  // 21:00 on the 26th in Toronto is already the 27th in UTC.
  const torontoEvening = new Date("2026-08-27T01:00:00.000Z");

  it("dates a letter by the school's day, not the server's", () => {
    const utc = (at: Date) => at.toISOString().slice(0, 10);
    const school = (tz: string, at: Date) => schoolToday(tz, at).toISOString().slice(0, 10);

    expect(utc(singaporeMorning)).toBe("2026-08-26");
    expect(school("Asia/Singapore", singaporeMorning)).toBe("2026-08-27");

    expect(utc(torontoEvening)).toBe("2026-08-27");
    expect(school("America/Toronto", torontoEvening)).toBe("2026-08-26");
  });

  it("keeps a cover taught YESTERDAY out of the withdrawal notice, east of UTC", () => {
    // The lesson was covered on the school's 26th; it is now the school's 27th.
    const taught = new Date("2026-08-26T00:00:00.000Z");
    const serverToday = new Date(singaporeMorning.toISOString().slice(0, 10));
    const schoolsToday = schoolToday("Asia/Singapore", singaporeMorning);

    // The shipped comparison announced it — `date >= today` with today = the
    // UTC 26th — so a teacher was told about a lesson already taught.
    expect(taught >= serverToday).toBe(true);
    // On the school's own day it is history, and stays out.
    expect(taught >= schoolsToday).toBe(false);
  });

  it("still announces a cover that is genuinely ahead", () => {
    const tomorrow = new Date("2026-08-28T00:00:00.000Z");
    expect(tomorrow >= schoolToday("Asia/Singapore", singaporeMorning)).toBe(true);
    expect(tomorrow >= schoolToday("America/Toronto", torontoEvening)).toBe(true);
  });
});

/** The visible text of a pdfkit document, decoded from its content streams. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let out = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      /* not a deflate stream — image bytes and the like */
    }
  }
  return [...out.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((h) => Buffer.from(h[1], "hex").toString("latin1"))
    .join("");
}

describe("the letter itself carries the school's date", () => {
  // A test on the helper proves nothing about the caller — the seam that hid the
  // CBT score and the report-card promotion line. This drives the real service.
  const letterFor = async (timezone: string) => {
    const employee = {
      id: "emp-1",
      userId: "u-1",
      jobTitle: "Head of Mathematics",
      department: "Mathematics",
      gradeLevel: null,
      employmentType: "FULL_TIME",
      startDate: new Date("2019-09-02T00:00:00.000Z"),
      endDate: null,
      status: "ACTIVE",
      confirmationStatus: "CONFIRMED",
    };
    const tx = {
      employee: { findFirst: async () => employee },
      user: { findFirst: async () => ({ name: "Ada Okonkwo" }) },
      school: { findFirst: async () => ({ name: "St Andrews Academy" }) },
    };
    const svc = new LetterService(
      { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) } as never,
      { record: async () => undefined } as never,
      { getLogoBytes: async () => null } as never,
      { forSchool: async () => ({ timezone }) } as never,
    );
    const { buffer } = await svc.generate(
      { userId: "actor", schoolId: "s-1" } as never,
      "u-1",
      "EMPLOYMENT",
    );
    return textOf(buffer);
  };

  it("prints the school's day, not the server's UTC day", async () => {
    const text = await letterFor("Asia/Singapore");
    const expected = schoolToday("Asia/Singapore").toISOString().slice(0, 10);
    expect(text).toContain(`Date: ${expected}`);
    // And it names the person, rather than the "Staff member" fallback.
    // GOTCHA: the body is JUSTIFIED, so pdfkit positions each word separately
    // and the extracted stream has no spaces between them. Compare with the
    // whitespace stripped rather than asserting the readable form.
    expect(text.replace(/\s+/g, "")).toContain("AdaOkonkwo");
  });

  it("prints a date for a school west of UTC too", async () => {
    const text = await letterFor("America/Toronto");
    expect(text).toContain(`Date: ${schoolToday("America/Toronto").toISOString().slice(0, 10)}`);
  });
});
