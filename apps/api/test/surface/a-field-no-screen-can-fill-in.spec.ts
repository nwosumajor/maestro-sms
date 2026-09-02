/**
 * AN INPUT THE API ACCEPTS AND NO SCREEN CAN SEND.
 *
 * A field arrives on a request schema, is stored, is returned in the DTO — and
 * no form ever fills it in. Nothing fails. The feature simply is not there, and
 * because the API half looks finished it reads as built. This repo has now been
 * bitten five times:
 *
 *   ?open=1        the meetings queue filter; its ONE caller ignored it
 *   country        provisioning; every school became the platform's own country
 *   effectiveDate  a salary raise dated for October, paid from August
 *   stopId         a per-stop bus fare that billed nobody
 *   commentId      a pupil could report the post, never the harmful REPLY
 *
 * A one-off sweep found 24 of these once. A sweep rots; this does not.
 *
 * THREE ANSWERS FOR A NEW OPTIONAL FIELD, and every one is a decision somebody
 * writes down: a screen sends it, or it is API_ONLY with a reason, or it goes on
 * AWAITING_A_SCREEN — which the gate requires to SHRINK, so an entry cannot
 * outlive the gap it records. Same shape as `AWAITING_CONSOLIDATION` in
 * `common/teaches.ts`.
 *
 * WHAT THIS CANNOT SEE, stated so nobody trusts it further than it goes: it
 * asks whether the web MENTIONS the identifier, and displaying a value is not
 * supplying one. `attachmentDocId` left this list the moment the leave page
 * rendered a link to the attachment, while ATTACHING one remains impossible for
 * most staff — see `an-approver-who-cannot-see-the-evidence`. A field that is
 * read but not writable is out of scope here and belongs in a test of its own.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { API_SRC, apiRoutes } from "../support/api-routes";

/**
 * Fields a screen SHOULD never send. Each is server-owned or device-owned, and
 * a form offering them would be the defect.
 */
const API_ONLY: Record<string, string> = {
  awardKind:
    "there is exactly ONE award kind the platform can pay out (DISBURSABLE_AWARD_KINDS), the service defaults to it, and a picker with one option is noise — revisit this the day a second disbursable kind exists",
  speedKph: "vehicle telemetry, posted by a tracker device — no human types it",
  headingDeg: "vehicle telemetry, posted by a tracker device — no human types it",
  odometerKm: "vehicle telemetry, posted by a tracker device — no human types it",
  vendor: "identifies the tracker hardware posting the reading, not a user choice",
  targetSecret:
    "the race target is generated SERVER-SIDE and never leaves it; a client supplying one would decide its own game",
  linkGuardian:
    "admissions conversion defaults it true and the UI is right to leave it — the override exists for an import, not a form",
  calendarTemplate:
    "provisioning derives it from the school's country; the field is an operator escape hatch for a school whose year does not match its region",
};

/**
 * Genuine gaps: the API accepts it, no screen can send it, and that is a
 * missing feature rather than a decision. NAMED so it is visible, and the gate
 * REQUIRES THIS LIST TO SHRINK — an entry that no longer matches must be
 * deleted, so it cannot outlive the gap it records.
 */
const AWAITING_A_SCREEN: Record<string, string> = {
  completedAt: "a checklist item cannot be back-dated to when it was actually done",
  documentId: "a checklist item cannot be linked to the document that satisfies it",
  feeItemId: "an invoice line cannot be linked to its fee-catalogue item",
  lessonsPerSubject: "the timetable generator's per-subject quota cannot be overridden from the console",
};

function walkWeb(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    // A SCREEN, not the tooling beside it. `scripts/` holds the hand-run probes
    // and the build helpers; a probe that NAMES a field — `probe:no-secrets`
    // lists `targetSecret` among the markers that must never reach a client —
    // is the opposite of a screen offering it, and reading one as the other
    // makes an API_ONLY reason look contradicted by the test that enforces it.
    if (e === "node_modules" || e === ".next" || e === "scripts") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkWeb(p, out);
    else if (/\.(tsx?|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

const WEB = join(__dirname, "..", "..", "..", "web");
const webSrc = walkWeb(WEB)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** Every optional field on a body schema declared in a controller. */
function optionalBodyFields(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of new Set(apiRoutes().map((r) => r.file))) {
    const src = readFileSync(file, "utf8");
    // A field is optional however its schema is SPELLED. This matched only
    // `z.…` and went blind the moment a field moved to a shared validator
    // (`completedAt: isoDay.nullish()`) — the extractor keying on a syntactic
    // shape rather than on the property, so a real backlog entry looked stale.
    const re = /(\w+)\s*:\s*(?:z\.[^,\n]*?|[A-Za-z_$][\w$]*)\.(optional|nullish)\(\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const where = found.get(m[1]) ?? [];
      const rel = file.replace(`${API_SRC}/`, "");
      if (!where.includes(rel)) where.push(rel);
      found.set(m[1], where);
    }
  }
  return found;
}

const fields = optionalBodyFields();
const unsent = [...fields.keys()].filter((f) => !new RegExp(`\\b${f}\\b`).test(webSrc)).sort();

describe("every optional input is one somebody can actually supply", () => {
  it("read a believable number of schemas", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing — the failure `a-gate-must-not-pass-by-finding-nothing` names.
    expect(fields.size).toBeGreaterThan(150);
    expect(webSrc.length).toBeGreaterThan(500_000);
  });

  it("every field no screen sends is a decision somebody wrote down", () => {
    const undeclared = unsent.filter((f) => !(f in API_ONLY) && !(f in AWAITING_A_SCREEN));
    expect(undeclared).toEqual([]);
  });

  it("the backlog SHRINKS — an entry that a screen now sends must be removed", () => {
    // Otherwise the list becomes a record of gaps that were closed years ago,
    // and the next reader stops trusting it.
    const stale = Object.keys(AWAITING_A_SCREEN).filter((f) => !unsent.includes(f));
    expect(stale).toEqual([]);
  });

  it("nothing is exempted as API-only once a screen sends it", () => {
    // The reverse rot: a field declared server-owned that a form now fills in
    // means the reason was wrong, and the reason is what the next reader trusts.
    const contradicted = Object.keys(API_ONLY).filter((f) => !unsent.includes(f));
    expect(contradicted).toEqual([]);
  });

  it("every entry in both lists gives a reason a reader can act on", () => {
    for (const [f, why] of [...Object.entries(API_ONLY), ...Object.entries(AWAITING_A_SCREEN)]) {
      expect({ f, long: why.length > 30 }).toEqual({ f, long: true });
    }
  });

  it("the two lists are disjoint", () => {
    // A field cannot be both server-owned and a missing screen; one of the two
    // reasons would be false.
    const both = Object.keys(API_ONLY).filter((f) => f in AWAITING_A_SCREEN);
    expect(both).toEqual([]);
  });
});
