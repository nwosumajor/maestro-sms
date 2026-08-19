// =============================================================================
// Golden Rule #5, on the one read in the file that was not obeying it
// =============================================================================
// "All reads/writes to student PII ... are audit-logged."
//
// A child's emergency contacts are the names, relationships and PHONE NUMBERS of
// the adults responsible for them — the most directly actionable personal data
// the platform holds about a family. Reading the whole list wrote nothing to the
// audit trail.
//
// The tell was sibling asymmetry rather than anything subtle. In the same
// service the profile read logs, the guardian read logs, the medical read logs,
// and every WRITE to these very rows logs — so ADDING a contact was recorded
// while reading all of them was not. The live audit log settled it: 193
// sis.guardians.read entries, 19 sis.medical.read, and no contact-read action in
// existence at all.
//
// The COUNT is recorded, never the numbers. An audit trail is read by people
// investigating access, who should not be handed the contact details as a side
// effect of checking who looked at them — the same rule the guardian read
// already follows.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const STAFF: Principal = { schoolId: "A", userId: "staff-1", roles: ["school_admin"], permissions: ["student.read"] };
const CONTACTS = [
  { id: "c1", name: "Ada Okoro", relationship: "Mother", phone: "+2348030000001", email: "ada@example.test", priority: 1 },
  { id: "c2", name: "Emeka Okoro", relationship: "Uncle", phone: "+2348030000002", email: null, priority: 2 },
];

function make() {
  const log = jest.fn();
  const tx = {
    emergencyContact: { findMany: jest.fn().mockResolvedValue(CONTACTS) },
  } as unknown as TenantTx;
  const s = Object.create(SisService.prototype) as SisService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
  });
  (s as unknown as { log: unknown }).log = log;
  (s as unknown as { assertCanAccessStudent: unknown }).assertCanAccessStudent = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { requireProfile: unknown }).requireProfile = jest.fn().mockResolvedValue({ id: "prof-1" });
  return { s, log, tx };
}

describe("reading a child's emergency contacts", () => {
  it("is recorded against the person who read them", async () => {
    const { s, log } = make();
    await s.listContacts(STAFF, "child-1");
    expect(log).toHaveBeenCalledWith(expect.anything(), STAFF, "sis.contact.read", "user", "child-1", { contacts: 2 });
  });

  it("still returns the contacts — the audit is not allowed to change the answer", async () => {
    const { s } = make();
    await expect(s.listContacts(STAFF, "child-1")).resolves.toEqual(CONTACTS);
  });

  it("records how many, never the numbers themselves", async () => {
    // The audit trail is read by people investigating access. Handing them the
    // phone numbers as a side effect would make the log its own disclosure.
    const { s, log } = make();
    await s.listContacts(STAFF, "child-1");
    const meta = JSON.stringify(log.mock.calls[0][5]);
    expect(meta).toContain("2");
    for (const c of CONTACTS) {
      expect(meta).not.toContain(c.phone);
      expect(meta).not.toContain(c.name);
    }
  });

  it("logs the empty case too, because looking and finding nothing is still looking", async () => {
    const { s, log, tx } = make();
    (tx.emergencyContact.findMany as jest.Mock).mockResolvedValue([]);
    await s.listContacts(STAFF, "child-1");
    expect(log).toHaveBeenCalledWith(expect.anything(), STAFF, "sis.contact.read", "user", "child-1", { contacts: 0 });
  });

  it("checks access BEFORE it reads, so a refusal never touches the rows", async () => {
    const { s, tx } = make();
    (s as unknown as { assertCanAccessStudent: jest.Mock }).assertCanAccessStudent.mockRejectedValue(
      new Error("not yours"),
    );
    await expect(s.listContacts(STAFF, "child-1")).rejects.toThrow("not yours");
    expect(tx.emergencyContact.findMany).not.toHaveBeenCalled();
  });
});

describe("every read of a child's personal data in this service", () => {
  it("writes an audit entry", async () => {
    // The gate that would have caught this one. A read method here is one that
    // asserts access to a student and then returns rows; each must log.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/sis/sis.service.ts"), "utf8");
    const missing: string[] = [];
    for (const m of src.matchAll(/\n  async (\w+)\s*\([\s\S]{0,300}?\)\s*(?::[^{]{0,160})?\{/g)) {
      const start = (m.index ?? 0) + m[0].length - 1;
      let depth = 0;
      let end = start;
      while (end < src.length) {
        if (src[end] === "{") depth += 1;
        else if (src[end] === "}" && --depth === 0) break;
        end += 1;
      }
      const body = src.slice(start, end);
      if (!/assertCanAccessStudent/.test(body)) continue;
      if (!/findMany\(|findFirst\(/.test(body)) continue;
      if (/\.(create|update|delete|upsert)\(/.test(body)) continue; // writes log separately
      // `completion` reports which fields are MISSING — field names, not values —
      // so it discloses nothing and logging it would be noise, not a trail.
      if (m[1] === "completion") continue;
      if (!/this\.log\(/.test(body)) missing.push(m[1]);
    }
    expect(missing).toEqual([]);
  });
});
