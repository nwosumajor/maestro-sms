// =============================================================================
// The gate log was written on every scan and read by nothing
// =============================================================================
// Swept for the shape behind #259 — a record that is written and never read —
// across every Prisma model. Four came back; three were my regex:
//
//   job_run            read via raw SQL in job-runs.service (the sweep only saw
//                      Prisma calls).
//   vehicle_location   read via raw SQL in transport.service.
//   school_group_member  read through a RELATION INCLUDE (`group.members`),
//                      which `.schoolGroupMember.findX(` never matches.
//
// The fourth was real. `scan_event` records every gate, library and exam-hall
// scan — who was scanned, who held the scanner, why, when — and NOTHING read
// it: no endpoint, no query, no export. A school could scan a child out at the
// gate and had no way to ask when they left, which is the only question a gate
// log exists to answer.
//
// The tell that it was an oversight rather than a decision: the table already
// carried BOTH indexes such a reader needs — `(schoolId, memberId)` for one
// person's history and `(schoolId, createdAt)` for the day. It was designed to
// be read. And retention projects it at 47M rows over ten years, the largest
// table the platform stores — all of it illegible.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const SERVICE = strip(SRC("certificate/member-scan.service.ts"));
const CONTROLLER = strip(SRC("certificate/member-scan.controller.ts"));

describe("a member's movements can be read", () => {
  it("queries by member, using the index that was already there", () => {
    expect(SERVICE).toMatch(/scanEvent\.findMany\(\{[\s\S]*?where: \{ memberId/);
  });

  it("is bounded by days AND by rows", () => {
    // 47M rows at ten years: "everything for this pupil" must not be a query
    // anyone can ask by accident.
    expect(SERVICE).toMatch(/Math\.min\(Math\.max\(days, 1\), 180\)/);
    expect(SERVICE).toMatch(/take: SCAN_HISTORY_CAP/);
  });

  it("is AUDITED — movement data about a minor is a Golden Rule #5 read", () => {
    expect(SERVICE).toMatch(/action: "member\.scan\.history"/);
  });

  it("404s a member of another school rather than confirming they exist", () => {
    expect(SERVICE).toMatch(/if \(!member\) throw new NotFoundException\("Member not found"\)/);
  });

  it("names the scanner, not just the scanned", () => {
    // A movement log that cannot say who recorded it is half a record.
    expect(SERVICE).toMatch(/scannedByName/);
  });

  it("resolves both names in ONE lookup, not one per row", () => {
    expect(SERVICE).toMatch(/where: \{ id: \{ in: ids \} \}/);
  });
});

describe("the day at the desk", () => {
  it("uses the SCHOOL's day, not the server's UTC one", () => {
    // The same rule the register, the term lock and the gate scan itself use.
    expect(SERVICE).toMatch(/schoolToday\(timezone\)/);
  });

  it("is audited too", () => {
    expect(SERVICE).toMatch(/action: "member\.scan\.today"/);
  });
});

describe("who may ask", () => {
  it("both reads are gated on member.scan — the permission that runs the desk", () => {
    const at = CONTROLLER.indexOf('@Get("scan/history/:memberId")');
    expect(at).toBeGreaterThan(-1);
    expect(CONTROLLER.slice(at, at + 200)).toMatch(/MEMBER_SCAN/);
    const today = CONTROLLER.indexOf('@Get("scan/today")');
    expect(CONTROLLER.slice(today, today + 160)).toMatch(/MEMBER_SCAN/);
  });

  it("declares them before the catch-all :code route", () => {
    // `@Get("scan/:code")` would otherwise swallow "scan/today" as a code.
    expect(CONTROLLER.indexOf('@Get("scan/today")')).toBeLessThan(
      CONTROLLER.indexOf('@Get("scan/:code")'),
    );
  });
});

describe("the reader on the pupil record", () => {
  const WEB = readFileSync(
    join(__dirname, "../../../web/components/sis/MovementLog.tsx"),
    "utf8",
  );

  it("does not claim 'never scanned' when the read failed", () => {
    expect(WEB).toMatch(/rows === null\) return null/);
    expect(WEB).toMatch(/No scans recorded in the last 30 days/);
  });

  it("says what each scan was in words, not the enum", () => {
    expect(WEB).toMatch(/CHECK_OUT: "Left"/);
  });
});
