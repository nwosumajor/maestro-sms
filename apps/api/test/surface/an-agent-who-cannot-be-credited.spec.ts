/**
 * AN AGENT WHO SIGNS A SCHOOL UP AND IS CREDITED WITH NOTHING.
 *
 * The agent programme pays commission on the first paid subscription of a
 * school it introduced. The whole chain existed on the server: the public
 * intake accepted `agentCode`, stored it on the onboarding request, and
 * provisioning resolved it onto `school_subscription.agentId` — falling back to
 * the stored request exactly as `country` and `referralCode` do.
 *
 * NO PAGE EVER SENT ONE. The public form carried a referral code and no agent
 * code, so attribution could not begin; and the operator's review queue did not
 * show it either, so a lead an agent had brought in was indistinguishable from
 * an organic one on the screen where it is decided.
 *
 * Found by the sweep in `a-field-no-screen-can-fill-in`, which is what that
 * gate is for. Driven live end to end afterwards: form -> request stores
 * PROBE-AG-01 -> operator queue shows it -> provisioning resolves it to the
 * agent with commissionBp 500.
 *
 * IT ARRIVES BY LINK, because that is how it will actually arrive: an agent
 * hands a prospect a URL. The field stays visible and editable so a code given
 * verbally is not lost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "..", "web");
const PAGE = readFileSync(join(WEB, "app", "onboard", "page.tsx"), "utf8");
const FORM = readFileSync(join(WEB, "components", "public", "OnboardForm.tsx"), "utf8");
const QUEUE = readFileSync(join(WEB, "components", "operator", "OnboardingRequests.tsx"), "utf8");
const DTO = readFileSync(
  join(__dirname, "..", "..", "..", "..", "packages", "types", "src", "dto", "public.ts"),
  "utf8",
);

describe("the public onboarding form", () => {
  it("takes an agent code from the link, like a referral", () => {
    expect(PAGE).toMatch(/searchParams:\s*\{[^}]*agent\?: string/);
    expect(PAGE).toContain("defaultAgentCode={agent}");
  });

  it("sanitises it the same way as the referral code", () => {
    // One `clean` for both — a second spelling is how the pair would drift, and
    // an unsanitised code reaches a `LIKE`-free lookup as whatever was typed.
    expect(PAGE).toMatch(/const clean = \(v: string \| undefined\) =>/);
    expect(PAGE).toMatch(/const ref = clean\(searchParams\.ref\)/);
    expect(PAGE).toMatch(/const agent = clean\(searchParams\.agent\)/);
  });

  it("SENDS it — the half that was missing", () => {
    expect(FORM).toMatch(/agentCode: f\.agentCode\.trim\(\) \|\| undefined/);
  });

  it("offers a field, so a code given verbally is not lost", () => {
    expect(FORM).toContain('htmlFor="o-agent"');
    expect(FORM).toMatch(/id="o-agent"/);
  });

  it("says it is not the referral reward, because they are different things", () => {
    // A referral is school-to-school and earns both a free term; an agent is
    // paid commission. A prospect who confuses them enters the wrong one.
    expect(FORM).toMatch(/separate from a referral code/i);
  });
});

describe("the operator's review queue", () => {
  it("carries the agent on the DTO", () => {
    expect(DTO).toMatch(/agentCode: string \| null;/);
  });

  it("shows who introduced the school", () => {
    // ANCHORED AT THE BRACE, so a disabling prefix breaks it. `{false &&
    // r.agentCode && (` still contains "r.agentCode &&" and passed — the same
    // mutation that got past the veto notice and the DTO capability flag.
    expect(QUEUE).toMatch(/\{r\.agentCode && \(/);
    expect(QUEUE).toContain("Agent ·");
  });

  it("keeps it distinct from the referral chip", () => {
    // One earns a free term, the other is money the platform owes somebody;
    // rendering them identically would hide which.
    expect(QUEUE).toContain("Referred ·");
    expect(QUEUE).toMatch(/commission accrues/i);
  });
});
