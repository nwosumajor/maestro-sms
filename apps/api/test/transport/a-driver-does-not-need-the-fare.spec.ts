// =============================================================================
// The person driving the bus does not need to know what each family pays
// =============================================================================
// Row scoping here is RIGHT, and measured live before touching anything: the
// demo school has 6 vehicles and 30 seat assignments; the driver drives 3 and
// sees exactly the 15 on those. The warden is the same — 6 hostels, 19
// allocations, sees 3 and 11.
//
// What every one of those rows carried was `fareMinor`. Fares vary per stop and
// per route, so that is a comparison BETWEEN FAMILIES, shown to the one role
// this project scopes to "read-only own vehicle".
//
// THE WARDEN IS THE CONTRAST THAT MAKES THIS A BOUNDARY AND NOT A MATTER OF
// TASTE: they see `rentMinor` on their boarders and that is correct, because
// they hold `hostel.manage` and allocating a room IS setting the rent. The
// driver holds `transport.read` and nothing else — the only role in the whole
// map that reads transport without managing it or reading fees.
// =============================================================================

import { TRANSPORT_PERMISSIONS, FEES_PERMISSIONS, ROLE_PERMISSIONS } from "@sms/types";

describe("who in the role map can read a fare", () => {
  const canSee = (perms: readonly string[]) =>
    perms.includes(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE) || perms.includes(FEES_PERMISSIONS.FEE_READ);

  it("finds the roles at all", () => {
    expect(Object.keys(ROLE_PERMISSIONS).length).toBeGreaterThan(15);
  });

  it("is nobody who merely reads transport, except the fleet head and finance", () => {
    const readsTransport = Object.entries(ROLE_PERMISSIONS).filter(([, perms]) =>
      (perms as readonly string[]).includes(TRANSPORT_PERMISSIONS.TRANSPORT_READ),
    );
    expect(readsTransport.length).toBeGreaterThan(2);
    const withheld = readsTransport.filter(([, perms]) => !canSee(perms as readonly string[])).map(([r]) => r);
    // Exactly the role this is about. If another role ever lands here it is a
    // decision to make deliberately, not to discover on a bus.
    expect(withheld).toEqual(["driver"]);
  });

  it("still shows it to the head driver, who sets the fares", () => {
    expect(canSee(ROLE_PERMISSIONS.head_driver as readonly string[])).toBe(true);
  });

  it("still shows it to the accountant, whose job it is", () => {
    expect(canSee(ROLE_PERMISSIONS.accountant as readonly string[])).toBe(true);
  });
});
