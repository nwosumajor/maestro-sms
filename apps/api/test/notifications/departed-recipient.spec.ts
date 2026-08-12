// =============================================================================
// Nothing is sent to somebody who has left
// =============================================================================
// The in-app inbox row is always written — it is the record, and a departed user
// cannot sign in to read it anyway. EXTERNAL delivery is a different matter: an
// SMS, email or WhatsApp to a departed pupil or teacher costs the school a paid
// message credit AND sends school information to someone no longer entitled to
// it. A withdrawn child's guardian being texted about next term's fees is the
// shape of complaint that produces.
//
// The check lives in `persist`, once, rather than at each of the ~40 producers —
// a rule that has to be remembered at every call site is one that will be missed.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "../../src/notifications/notification.service.ts"),
  "utf8",
);

describe("external delivery to a departed recipient", () => {
  it("is suppressed in ONE place, not per producer", () => {
    const persist = SRC.slice(SRC.indexOf("private async persist"));
    expect(persist).toMatch(/recipient\.status !== "ACTIVE"\) channels = \[\]/);
  });

  it("still writes the in-app row — the record survives the departure", () => {
    // Ordering matters: the notification row is created BEFORE channels are
    // resolved, so suppressing delivery cannot suppress the record.
    const persist = SRC.slice(SRC.indexOf("private async persist"));
    const created = persist.indexOf("tx.notification.create");
    const suppressed = persist.indexOf('recipient.status !== "ACTIVE"');
    expect(created).toBeGreaterThan(-1);
    expect(suppressed).toBeGreaterThan(created);
  });

  it("costs no extra query when there was nothing to send anyway", () => {
    // Most notifications are in-app only. Looking up the recipient every time
    // would add a query per notification across the busiest path in the product.
    const persist = SRC.slice(SRC.indexOf("private async persist"));
    expect(persist).toMatch(/if \(channels\.length > 0\) \{[\s\S]{0,200}?tx\.user\.findFirst/);
  });

  it("does not suppress when the recipient cannot be read", () => {
    // `recipient &&` — an unreadable row means "we do not know", and silently
    // dropping a fee receipt because a lookup returned nothing would be the
    // worse failure. Fails open on delivery, closed on departure.
    const persist = SRC.slice(SRC.indexOf("private async persist"));
    expect(persist).toMatch(/if \(recipient && recipient\.status !== "ACTIVE"\)/);
  });
});
