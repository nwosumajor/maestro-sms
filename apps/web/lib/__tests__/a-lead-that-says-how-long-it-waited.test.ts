/**
 * The operator's onboarding queue must say how long a lead has waited.
 *
 * The review card rendered the school, its size, its address and its contacts,
 * and NO date. The list is ordered oldest-first, so the longest wait is already
 * at the top — but nothing on the row said it was a long wait, and a request
 * submitted three weeks ago looked exactly like one submitted this morning.
 *
 * Every other waiting thing in this product states its age: an overdue book, a
 * boarder signed out too long, a staff certificate expiring, a breach past its
 * statutory deadline. This is the one queue where the wait is a school deciding
 * the platform never answered — the only unanswered thing here that is revenue.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CARD = readFileSync(join(__dirname, "../../components/operator/OnboardingRequests.tsx"), "utf8");

describe("a lead that says how long it waited", () => {
  it("renders the request's own date", () => {
    // createdAt was on the DTO and reaching the browser all along; it was simply
    // never drawn. The bug was in the rendering, not the data.
    expect(CARD).toMatch(/r\.createdAt/);
  });

  it("calls out one that has waited too long", () => {
    expect(CARD).toMatch(/STALE_LEAD_DAYS/);
    expect(CARD).toMatch(/not yet answered/);
  });

  it("says it only while the request is still undecided", () => {
    // A DECIDED request shows its date and nothing more. "Waiting 40 days" on a
    // request that was answered on day one is a false statement about the
    // platform's own responsiveness, and it would train an owner to ignore the
    // marker on the rows where it is true.
    expect(CARD).toMatch(/UNDECIDED\.has\(r\.status\)/);
    expect(CARD).toMatch(/new Set\(\["NEW", "REVIEWING"\]\)/);
  });

  it("counts whole days and never a negative one", () => {
    // A clock skewed forward would otherwise render "-1 days".
    expect(CARD).toMatch(/Math\.max\(0, Math\.floor/);
  });
});
