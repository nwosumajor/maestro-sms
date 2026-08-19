// =============================================================================
// What a family is allowed to switch off
// =============================================================================
// The preference model already carried the right principle, written beside
// DISCIPLINE_OUTCOME: "a guardian must not be able to mute, by accident or
// otherwise, the message telling them a sanction was recorded against their
// child's name."
//
// Attendance did not follow it. A guardian could switch off attendance alerts —
// the message through which a family learns their child never arrived at school
// — while a payment receipt could not be switched off at all. The reason it was
// mutable is defensible on its own terms: ABSENT and LATE shared ONE type, so
// the only way to stop a punctuality nudge every time a child was five minutes
// late was to stop the absence alert with it. Nobody should have to make that
// trade, so they are now two types:
//
//   ATTENDANCE_ABSENCE   essential — the child is not there and nobody said why
//   ATTENDANCE_LATE      mutable   — a nudge
//
// The second half is the curated list itself. It was documented as "just the
// curated set worth surfacing as checkboxes" while the column took any string
// the client sent, so every non-essential type the platform emits — a hostel
// notice, a scholarship decision, a change to a child's SIS record — could be
// muted by a request that simply named it, with no screen ever offering it.
// The list is now the boundary, enforced in the pure function every delivery
// passes through as well as at the endpoint.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allowedChannels,
  ESSENTIAL_NOTIFICATION_TYPES,
  MUTABLE_NOTIFICATION_TYPES,
  type NotificationPreferenceDto,
} from "@sms/types";

const ALL = ["EMAIL", "SMS", "WHATSAPP"] as const;
/** A guardian who has muted everything the UI offers, on every channel. */
const mutesEverything: NotificationPreferenceDto = {
  emailEnabled: true,
  smsEnabled: true,
  whatsappEnabled: true,
  mutedTypes: MUTABLE_NOTIFICATION_TYPES.map((m) => m.type),
};

describe("the alert that says a child did not arrive", () => {
  it("cannot be muted", () => {
    expect(allowedChannels(mutesEverything, "ATTENDANCE_ABSENCE", ALL)).toEqual([...ALL]);
  });

  it("is not offered as a checkbox either — the UI renders this list", () => {
    expect(MUTABLE_NOTIFICATION_TYPES.map((m) => m.type)).not.toContain("ATTENDANCE_ABSENCE");
    expect(ESSENTIAL_NOTIFICATION_TYPES as readonly string[]).toContain("ATTENDANCE_ABSENCE");
  });

  it("is still subject to the CHANNEL toggles, which are a different decision", () => {
    // Essential means "you cannot mute this type", not "we will text you
    // whatever you said about texting". Turning off SMS entirely is a deliberate,
    // whole-account choice and the in-app inbox is always written regardless.
    const noSms = { ...mutesEverything, smsEnabled: false };
    expect(allowedChannels(noSms, "ATTENDANCE_ABSENCE", ALL)).toEqual(["EMAIL", "WHATSAPP"]);
  });
});

describe("the nudge that says a child was late", () => {
  it("CAN be muted, which is the whole reason for splitting the two", () => {
    expect(allowedChannels(mutesEverything, "ATTENDANCE_LATE", ALL)).toEqual([]);
  });

  it("is offered as its own checkbox", () => {
    expect(MUTABLE_NOTIFICATION_TYPES.map((m) => m.type)).toContain("ATTENDANCE_LATE");
  });
});

describe("a mute for a type the school never made optional", () => {
  it.each([["SIS_PROFILE"], ["HOSTEL"], ["SCHOLARSHIP"], ["MEETING"], ["INTEGRITY_SIGNAL"]])(
    "%s is delivered anyway",
    (type) => {
      // All five are real types the live platform emits and no screen offers.
      const pref: NotificationPreferenceDto = { ...mutesEverything, mutedTypes: [type] };
      expect(allowedChannels(pref, type, ALL)).toEqual([...ALL]);
    },
  );

  it("is refused by the endpoint rather than stored", () => {
    const src = readFileSync(join(__dirname, "../../src/notifications/notification.controller.ts"), "utf8");
    expect(src).toMatch(/z\.enum\(MUTABLE_NOTIFICATION_TYPES\.map/);
    expect(src).not.toMatch(/mutedTypes:\s*z\.array\(z\.string\(\)/);
  });
});

describe("the attendance register", () => {
  it("picks the type from the mark, so one mute cannot silence the other", () => {
    const src = readFileSync(join(__dirname, "../../src/attendance/attendance.service.ts"), "utf8");
    expect(src).toMatch(/type: g\.status === "LATE" \? "ATTENDANCE_LATE" : "ATTENDANCE_ABSENCE"/);
  });
});

describe("the rest of the preference model, unchanged", () => {
  it("no preference row at all still delivers everything", () => {
    // The historical default, and the one every existing family is on.
    expect(allowedChannels(null, "ATTENDANCE_LATE", ALL)).toEqual([...ALL]);
  });

  it("every essential type ignores a mute", () => {
    for (const t of ESSENTIAL_NOTIFICATION_TYPES) {
      expect(allowedChannels({ ...mutesEverything, mutedTypes: [t] }, t, ALL)).toEqual([...ALL]);
    }
  });

  it("the two lists never overlap — a type cannot be both", () => {
    const mutable = new Set(MUTABLE_NOTIFICATION_TYPES.map((m) => m.type));
    for (const t of ESSENTIAL_NOTIFICATION_TYPES) expect(mutable.has(t)).toBe(false);
  });
});
