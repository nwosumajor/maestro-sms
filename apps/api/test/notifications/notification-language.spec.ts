// =============================================================================
// Per-recipient language — the reason the key is deferred to persist()
// =============================================================================
// A producer composing a sentence has already chosen a language, and it does not
// know who is about to read it. `enqueueMany` sends ONE notification to a class
// of guardians who need not share a language, so the choice has to happen once
// per recipient, at the moment the row is written.
//
// This is the test that would have caught rendering once and reusing it.

import { NotificationService, type NotificationInput } from "../../src/notifications/notification.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const actor: TenantContext = { schoolId: "school-A", userId: "system" };

/** A tx whose users have the given locales, capturing every row written. */
function harness(locales: Record<string, string | null>, schoolLocale = "en-NG") {
  const written: Array<{ recipientId: string; title: string; body: string }> = [];
  const tx = {
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ locale: locales[where.id] ?? null }),
      ),
    },
    notification: {
      create: jest.fn(({ data }: { data: { recipientId: string; title: string; body: string } }) => {
        written.push({ recipientId: data.recipientId, title: data.title, body: data.body });
        return Promise.resolve({ id: `n-${written.length}`, ...data });
      }),
    },
    notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
    notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const regions = { forSchool: jest.fn().mockResolvedValue({ locale: schoolLocale }) };
  const svc = new NotificationService(db as never, audit as never, queue as never, undefined, undefined, regions as never);
  return { svc, written, regions, tx };
}

const ABSENCE: Omit<NotificationInput, "recipientId"> = {
  type: "ATTENDANCE_ABSENCE",
  key: "attendance.absent",
  params: { date: "2027-02-10" },
  title: "Attendance alert",
  body: "Your child was marked ABSENT on 2027-02-10.",
};

describe("one notification, two languages", () => {
  it("writes EACH guardian in their own language", async () => {
    // The same child, two guardians, different languages. Rendering once and
    // reusing it would give them both whichever was resolved first.
    const { svc, written } = harness({ "g-fr": "fr-SN", "g-en": "en-GB" });
    await svc.enqueueMany(actor, ["g-fr", "g-en"], ABSENCE);
    const fr = written.find((w) => w.recipientId === "g-fr")!;
    const en = written.find((w) => w.recipientId === "g-en")!;
    expect(fr.body).toContain("Votre enfant");
    expect(en.body).toContain("Your child");
    expect(fr.body).not.toBe(en.body);
  });

  it("falls back to the SCHOOL's language for a user who has not chosen", async () => {
    const { svc, written } = harness({ "g-1": null }, "fr-CI");
    await svc.enqueueMany(actor, ["g-1"], ABSENCE);
    expect(written[0].body).toContain("Votre enfant");
  });

  it("lets a user's own choice beat their school's", async () => {
    // An anglophone principal at a francophone school, and the reason language
    // is per user rather than per school.
    const { svc, written } = harness({ "g-1": "en-GB" }, "fr-CI");
    await svc.enqueueMany(actor, ["g-1"], ABSENCE);
    expect(written[0].body).toContain("Your child");
  });

  it("stores the localised text, so the inbox and the SMS cannot disagree", async () => {
    // Rendering at DELIVERY time instead would let a parent's SMS say one thing
    // and their in-app inbox another.
    const { svc, written } = harness({ "g-1": "fr-SN" });
    await svc.enqueueMany(actor, ["g-1"], ABSENCE);
    expect(written[0].title).toBe("Alerte de présence");
  });

  it("keeps the producer's English when no key is given", async () => {
    // The ~95 unmigrated producers must be untouched.
    const { svc, written } = harness({ "g-1": "fr-SN" });
    await svc.enqueueMany(actor, ["g-1"], { type: "GENERIC", title: "Plain title", body: "Plain body" });
    expect(written[0]).toMatchObject({ title: "Plain title", body: "Plain body" });
  });

  it("keeps the producer's English when the key is unknown", async () => {
    const { svc, written } = harness({ "g-1": "fr-SN" });
    await svc.enqueueMany(actor, ["g-1"], { ...ABSENCE, key: "attendance.absnet" });
    expect(written[0].body).toBe("Your child was marked ABSENT on 2027-02-10.");
    expect(written[0].body).not.toContain("absnet");
  });

  it("does not consult the school when the user has their own language", async () => {
    // One cached region read per school is cheap, but doing it for a recipient
    // who has already answered is pure waste on a class-sized batch.
    const { svc, regions } = harness({ "g-1": "fr-SN" });
    await svc.enqueueMany(actor, ["g-1"], ABSENCE);
    expect(regions.forSchool).not.toHaveBeenCalled();
  });
});
