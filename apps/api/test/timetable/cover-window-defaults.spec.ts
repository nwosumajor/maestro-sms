// =============================================================================
// A teacher's cover list, dated by the browser's clock in UTC
// =============================================================================
// `GET /timetable/cover/mine` required `from` and `to`, and its only caller
// computed them in the browser:
//
//     const from = new Date().toISOString().slice(0, 10);   // the UTC day
//
// Two faults, both of the kinds this codebase has a documented rule against:
//
//   1. "Today" is the SCHOOL's calendar day, not the server's and not the
//      user's. `toISOString()` is UTC. West of UTC it rolls over early: a
//      teacher in Toronto opening the page at 20:00 on Monday asks for
//      Tuesday onward and cannot see the duty they are about to cover. The
//      register, the gate scan, the term lock and the exam release gate all
//      use `schoolToday(tz)`; this did not.
//
//   2. Omitting the parameters built `new Date("undefinedT00:00:00.000Z")` —
//      an Invalid Date, which Prisma rejects with a 500. The same shape as the
//      staff attendance summary, where a range check could not see the NaN.
//
// The window now defaults on the SERVER, in the school's timezone.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { LessonCoverService } from "../../src/timetable/lesson-cover.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = {
  schoolId: "S",
  userId: "teacher-1",
  roles: ["teacher"],
  permissions: ["timetable.read"],
};

function makeService(timezone: string) {
  const asked: Array<{ gte: Date; lte: Date }> = [];
  const tx = {
    lessonCover: {
      findMany: jest.fn(async (a: { where: { date: { gte: Date; lte: Date } } }) => {
        asked.push(a.where.date);
        return [];
      }),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn(async () => []) },
    period: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = {
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const region = { forSchool: jest.fn(async () => ({ timezone })) };
  const svc = new LessonCoverService(
    db as never,
    { record: jest.fn() } as never,
    { notify: jest.fn() } as never,
    region as never,
  );
  return { svc, asked };
}

/** What the school's wall clock says today is. */
function schoolDay(tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(new Date());
}

describe("asking for cover duties without naming a window", () => {
  it("answers rather than building an Invalid Date", async () => {
    const { svc, asked } = makeService("Africa/Lagos");
    await expect(svc.myDuties(p)).resolves.toEqual([]);
    expect(asked).toHaveLength(1);
    expect(Number.isNaN(asked[0].gte.getTime())).toBe(false);
    expect(Number.isNaN(asked[0].lte.getTime())).toBe(false);
  });

  it("starts from the SCHOOL's today, not the server's UTC day", async () => {
    // Kiritimati is UTC+14 and Niue is UTC-11: on almost every run of this test
    // they are different calendar days, and at most one of them is UTC's.
    for (const tz of ["Pacific/Kiritimati", "Pacific/Niue", "Africa/Lagos", "America/Toronto"]) {
      const { svc, asked } = makeService(tz);
      await svc.myDuties(p);
      expect([tz, asked[0].gte.toISOString().slice(0, 10)]).toEqual([tz, schoolDay(tz)]);
    }
  });

  it("covers the next four weeks from that day", async () => {
    const { svc, asked } = makeService("Africa/Lagos");
    await svc.myDuties(p);
    const days = (asked[0].lte.getTime() - asked[0].gte.getTime()) / 86_400_000;
    expect(days).toBe(28);
  });
});

describe("the evening a teacher west of UTC would have lost", () => {
  it("does not skip today for a timezone whose day is behind UTC's", async () => {
    // The concrete failure: 20:00 Monday in Toronto is Tuesday 00:00 UTC. The
    // old code sent Tuesday and the teacher's Monday duty vanished from a list
    // whose whole purpose is telling them what they must cover.
    const { svc, asked } = makeService("America/Toronto");
    await svc.myDuties(p);
    const utcDay = new Date().toISOString().slice(0, 10);
    const asked0 = asked[0].gte.toISOString().slice(0, 10);
    expect(asked0).toBe(schoolDay("America/Toronto"));
    // Whenever the two differ, the school's day is the earlier one and is what
    // we used. (They agree for most of the day, so this is not always exercised
    // — the assertion above is the one that always holds.)
    if (asked0 !== utcDay) expect(asked0 < utcDay).toBe(true);
  });
});

describe("a window the caller DOES name", () => {
  it("is used as given", async () => {
    const { svc, asked } = makeService("Africa/Lagos");
    await svc.myDuties(p, "2026-09-01", "2026-09-10");
    expect(asked[0].gte.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(asked[0].lte.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("defaults only the half that is missing", async () => {
    const { svc, asked } = makeService("Africa/Lagos");
    await svc.myDuties(p, "2026-09-01");
    expect(asked[0].gte.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(asked[0].lte.toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });

  it("is REFUSED when malformed, rather than silently answering for another", async () => {
    const { svc } = makeService("Africa/Lagos");
    await expect(svc.myDuties(p, "banana")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.myDuties(p, "2026-13-45")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.myDuties(p, "01/09/2026")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is refused when it runs backwards or is absurdly long", async () => {
    const { svc } = makeService("Africa/Lagos");
    await expect(svc.myDuties(p, "2026-09-10", "2026-09-01")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.myDuties(p, "2026-01-01", "2027-01-01")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("the caller that started this", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../../web/components/timetable/MyCoverDuties.tsx"),
    "utf8",
  ) as string;

  it("no longer dates the request from the browser's clock", () => {
    // Asserted on the CODE, not the file: the header comment describes the old
    // `new Date().toISOString()` on purpose, and a naive text search matched
    // its own explanation.
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/toISOString/);
    expect(code).not.toMatch(/Date\.now/);
  });

  it("no longer fetches at all — it is handed its rows", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/"use client"/);
    expect(code).toMatch(/duties \}: \{ duties: Duty\[\] \| null \}/);
  });
});
