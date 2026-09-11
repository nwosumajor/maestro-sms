// =============================================================================
// Five strings, in four lists, naming notifications that do not exist
// =============================================================================
// `NotificationInput.type` was `NotificationTypeValue | string`, so the union
// gated nothing and any emitter could invent a category. Four hand-kept lists
// grew beside it — the union, the ESSENTIAL set, the MUTABLE mute screen, and a
// `FILTERABLE_TYPES` array in the web written specifically to work around the
// union being "knowingly incomplete". None was tied to what is actually sent.
//
// Measured on a parent three years in, holding 3,320 notifications across six
// types the platform really emits:
//
//     dropdown options offered .................. 12
//     options that returned anything ............  2
//     options that can NEVER match anyone ....... GRADE_POSTED, ONBOARDING
//     unreachable through ANY option ............ 2,213 of 3,320  (67%)
//
// `GRADE_POSTED` appears in no file in apps/api/src at all. `ONBOARDING` is an
// HR CHECKLIST type. `GRADE_PUBLISH`, `LMS_CONTENT_PUBLISH` and
// `ADMIN_APPOINTMENT` are WORKFLOW REQUEST types, and `LEAGUE` is a COMPETITION
// type — all four sat in the mute screen or the essential set, governing
// nothing. Four of the eight mute checkboxes did nothing at all.
//
// The compiler is the real gate now: `type` is the union, so an emitter cannot
// invent a category. This file guards the things a type cannot — that every
// catalogue entry is REACHABLE (it has a label, so the inbox can offer it), and
// that the subsets are subsets.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  MUTABLE_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
} from "@sms/types";

const API_SRC = join(__dirname, "../../src");
const WEB = join(__dirname, "../../../web");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

const API_FILES = walk(API_SRC);
const API_SOURCE = API_FILES.map((f) => readFileSync(f, "utf8")).join("\n");

describe("the catalogue is the one list", () => {
  it("scanned a believable amount of source", () => {
    // A walk that finds nothing produces no offenders and passes green.
    expect(API_FILES.length).toBeGreaterThan(200);
    expect(API_SOURCE.length).toBeGreaterThan(500_000);
  });

  it("every type a reader can be SENT, a reader can FILTER TO", () => {
    // The inbox menu is built from these labels. A catalogue entry with no
    // label is a category that exists in the table and nowhere on the screen —
    // which is the shape that hid 67% of one parent's inbox.
    const unlabelled = NOTIFICATION_TYPES.filter((t) => !NOTIFICATION_TYPE_LABELS[t]);
    expect(unlabelled).toEqual([]);
  });

  it("carries no label for a type that is not in the catalogue", () => {
    const extra = Object.keys(NOTIFICATION_TYPE_LABELS).filter(
      (t) => !(NOTIFICATION_TYPES as readonly string[]).includes(t),
    );
    expect(extra).toEqual([]);
  });

  it("the ESSENTIAL set names only real types", () => {
    // It named "ONBOARDING" (an HR checklist type) and "ADMIN_APPOINTMENT" (a
    // workflow request type). A protection keyed on a string no row carries
    // protects nothing, and reads as though it does.
    const ghosts = ESSENTIAL_NOTIFICATION_TYPES.filter(
      (t) => !(NOTIFICATION_TYPES as readonly string[]).includes(t),
    );
    expect(ghosts).toEqual([]);
  });

  it("the MUTABLE set names only real types", () => {
    // Four of its eight entries governed nothing.
    const ghosts = MUTABLE_NOTIFICATION_TYPES.map((m) => m.type).filter(
      (t) => !(NOTIFICATION_TYPES as readonly string[]).includes(t),
    );
    expect(ghosts).toEqual([]);
  });

  it("a type is never both essential and mutable", () => {
    // They mean opposite things: one cannot be switched off, the other can.
    const both = MUTABLE_NOTIFICATION_TYPES.map((m) => m.type).filter((t) =>
      (ESSENTIAL_NOTIFICATION_TYPES as readonly string[]).includes(t),
    );
    expect(both).toEqual([]);
  });
});

/**
 * The argument blocks of every call that CREATES a notification.
 *
 * Scoped deliberately. A first version of this searched the whole API source for
 * `type: "X"`, and a mutation reverting the LMS emitter to ANNOUNCEMENT passed
 * all fifteen tests — because `LMS_CONTENT_PUBLISH` still appeared elsewhere in
 * the file as a WORKFLOW REQUEST type. The gate had the very confusion it exists
 * to catch: it could not tell a notification type from a workflow type, which is
 * how four dead checkboxes got onto the preferences screen in the first place.
 */
function notificationCallArgs(): string {
  // The notifier's own methods, PLUS any local helper that forwards to it — a
  // function whose parameter is typed `NotificationTypeValue` is an emitter by
  // definition, and its callers are where the literal actually lives. Fees and
  // the library both route family messages through one such builder, so a scan
  // that only knew the notifier's method names reported FEE_REMINDER as unsent.
  const forwarders = new Set<string>();
  for (const f of API_FILES) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:private |public )?(?:async )?(\w+)\s*\([^)]*?:\s*\{[^}]*\btype:\s*NotificationTypeValue/gs)) {
      forwarders.add(m[1]);
    }
  }
  const names = ["enqueue", "enqueueMany", "notifyPermissionHolders", "send", ...forwarders];
  const CALL = new RegExp(`\\.(${names.join("|")})\\s*\\(`, "g");
  const out: string[] = [];
  for (const f of API_FILES) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(CALL)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      let arg = "";
      while (i < src.length && depth > 0) {
        const c = src[i];
        if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c)) {
          depth -= 1;
          if (depth === 0) break;
        }
        arg += c;
        i += 1;
      }
      out.push(arg);
    }
  }
  return out.join("\n@@\n");
}

const NOTIFY_ARGS = notificationCallArgs();

describe("a mute checkbox governs something that is actually sent", () => {
  it("found the notification call sites at all", () => {
    // A scan that matches nothing reports every type as absent, which would
    // fail loudly — but a scan that matches everything reports every type as
    // present, which passes silently. Pin the magnitude.
    expect(NOTIFY_ARGS.split("@@").length).toBeGreaterThan(40);
    expect(NOTIFY_ARGS.length).toBeLessThan(API_SOURCE.length / 4);
  });

  /** Does an emitter write this type? Matches a plain literal and a ternary
   *  alike, since attendance picks its type from the mark. */
  const isEmitted = (t: string) => new RegExp(`type:[^\\n]*"${t}"`).test(NOTIFY_ARGS);

  it.each(MUTABLE_NOTIFICATION_TYPES.map((m) => [m.type, m.label]))(
    "%s (%s) is emitted by at least one path",
    (type) => {
      // The defect in one line: a parent switches off "New lessons & materials"
      // and keeps getting them, because the emitter sent ANNOUNCEMENT. Or turns
      // off "Alumni broadcasts", which never went through notifications at all.
      expect(isEmitted(type as string)).toBe(true);
    },
  );

  it("and the five ghosts stay gone", () => {
    // Named, so their return is a failure that says which one and why.
    for (const ghost of [
      "GRADE_POSTED", // in no API file at all
      "ONBOARDING", // an HR checklist type
      "ADMIN_APPOINTMENT", // a workflow request type
      "GRADE_PUBLISH", // a workflow request type
      "LEAGUE", // a competition type
      "ALUMNI_BROADCAST", // alumni deliberately bypasses the notification funnel
    ]) {
      expect(NOTIFICATION_TYPES as readonly string[]).not.toContain(ghost);
      expect(MUTABLE_NOTIFICATION_TYPES.map((m) => m.type)).not.toContain(ghost);
      expect(ESSENTIAL_NOTIFICATION_TYPES as readonly string[]).not.toContain(ghost);
    }
  });
});

describe("the web does not keep a thirteenth copy of the list", () => {
  it("the inbox filter is DERIVED from the catalogue", () => {
    const src = readFileSync(join(WEB, "components/notifications/NotificationInbox.tsx"), "utf8");
    // The SHARED stripper, not a hand-rolled regex: the two-line version
    // swallows real code whenever a comment contains a `/*` (a path glob, say),
    // and a `not.toMatch` over a swallowed region passes VACUOUSLY.
    const code = stripComments(src);
    expect(code).toMatch(/FILTERABLE_TYPES[^=]*=\s*NOTIFICATION_TYPES/);
    // And not a hand-written array of type strings beside it.
    expect(code).not.toMatch(/const FILTERABLE_TYPES\s*=\s*\[\s*"/);
  });
});
