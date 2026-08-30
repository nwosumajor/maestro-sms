/**
 * A FAMILY PAGE THAT CANNOT SAY THE CHILD HAS LEFT.
 *
 * A student exit closes the account, every enrolment, the hostel allocation and
 * the transport assignment — and DELIBERATELY keeps the guardian link:
 * `parent_child` is the family-scope access table, and a leaver keeps their
 * guardians on the same reasoning that keeps their name on their own past
 * records. The family still needs their invoices, documents and report cards.
 *
 * The cost was that nothing SAID so. With no ACTIVE enrolment `className` goes
 * null — which is exactly what a pupil whose class was never set looks like.
 * Measured live on a real exit: the card showed the child with a blank class,
 * and the parent had no way to tell that from an unassigned one while the
 * school's own record said they had gone.
 *
 * Same rule this repo applies to a register with no rows ("no register yet" and
 * "attended nothing" are different facts about a child) and to the export
 * bundle's coverage manifest: a blank must not stand in for two different
 * answers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(join(__dirname, "..", "..", "src", "parent", "parent.service.ts"), "utf8");
const PAGE = readFileSync(
  join(__dirname, "..", "..", "..", "..", "apps", "web", "app", "(app)", "family", "page.tsx"),
  "utf8",
);

describe("the family overview and a departed child", () => {
  it("reads the pupil's exit alongside their name", () => {
    expect(SERVICE).toMatch(/select: \{ id: true, name: true, exitedAt: true, status: true \}/);
  });

  it("reports a date only for a pupil the school has actually exited", () => {
    // A null or ACTIVE status is on roll; reporting a date for either would
    // tell a family their child had left.
    expect(SERVICE).toContain('child.status === "ACTIVE" ? null : (child.exitedAt ?? null)');
  });

  it("keeps the guardian link rather than cutting it on exit", () => {
    // The access is the point: withdrawing it would leave a family unable to
    // reach the invoices they still owe and the records they are entitled to.
    // `getFamilyOverview` scopes on the link alone, with no status filter.
    const body = SERVICE.slice(SERVICE.indexOf("async getFamilyOverview("));
    expect(body).toMatch(/parentChild\.findMany\(\{\s*where: \{ parentId: p\.userId \}/);
    expect(body).not.toMatch(/parentChild\.findMany[\s\S]{0,160}status:/);
  });

  it("the page says they have left instead of showing a blank class", () => {
    expect(PAGE).toContain("Left the school on");
    expect(PAGE).toMatch(/c\.exitedAt &&/);
  });

  it("dates it on the SCHOOL's clock, not the platform's", () => {
    // `exitedAt` is a true instant, so it converts; the page is a server
    // component and binds the region explicitly.
    expect(PAGE).toContain("shortDate(c.exitedAt, region)");
  });
});
