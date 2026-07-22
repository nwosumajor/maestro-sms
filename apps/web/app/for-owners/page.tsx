import Link from "next/link";
import type { Metadata } from "next";
import { CYCLE_DISCOUNT_PERCENT, PLANS } from "@sms/types";
import { CheckIcon, ShieldCheckIcon, WalletIcon, ClockIcon, UsersIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SiteHeader } from "@/components/marketing/SiteHeader";

// PUBLIC marketing page for proprietors, owners and boards evaluating the
// platform. The written long-form proposal lives at docs/SCHOOL_OWNER_PROPOSAL.md
// and remains the document we send by email; this page is its web treatment.
//
// ACCURACY RULE (same as /help): every claim here must be TRUE of the shipped
// system. No forward-looking promises, no unbuilt features. Where a number is
// quoted it must come from a constant in @sms/types or a real enforced policy.
export const metadata: Metadata = {
  title: "For school owners — MAESTRO-SMS",
  description:
    "Collect more of the fees you are owed, cut administrative cost, and run your school on enforced internal controls. A proposal to proprietors, owners and boards.",
};

// PRICING ACCURACY: the commitment discounts and the plan count are DERIVED from
// @sms/types, never typed as prose — change CYCLE_DISCOUNT_PERCENT or PLANS and
// this page follows automatically. The two static documents that quote the same
// numbers (the leader's manual and the owner proposal) cannot import constants,
// so they are guarded by pricing-consistency.test.ts instead.
const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"] as const;
// Capitalised: this word opens a sentence in the pricing paragraph below.
const PLAN_COUNT_WORD =
  NUMBER_WORDS[Object.keys(PLANS).length] ?? String(Object.keys(PLANS).length);

const PROBLEMS: { cost: string; detail: string }[] = [
  { cost: "Money you never see", detail: "Cash collection leaks. Arrears age silently in a notebook. Nobody can say, today, exactly who owes what." },
  { cost: "Time your staff burn", detail: "Evenings lost computing results by hand. Report cards written out class by class. Payroll rebuilt in a spreadsheet every month." },
  { cost: "Trust you quietly spend", detail: "Parents hear about problems weeks late. Disputes resolve on memory. One person handles both the money and the record of it." },
];

const PILLARS: { icon: typeof WalletIcon; title: string; body: string }[] = [
  {
    icon: WalletIcon,
    title: "Fees settle to your bank, not ours",
    body: "Parents pay online by card or dedicated transfer account. Receipts issue automatically, arrears track themselves, and the money settles directly into your school's own account. The platform never holds your funds.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Internal control, enforced by software",
    body: "Large payments and every refund need a second person. So do salary changes, payroll runs, fee waivers and published results. Separation of duties is enforced by the platform, not by a policy memo nobody reads.",
  },
  {
    icon: LockIcon,
    title: "Isolation the database itself enforces",
    body: "Your school's data is separated in three independent layers — the login token, the application, and PostgreSQL Row-Level Security. Even a software bug cannot serve another school your records, because the database refuses.",
  },
  {
    icon: ClockIcon,
    title: "The clerical work runs itself",
    body: "Results compute and report cards generate as branded PDFs. Attendance alerts guardians the same day. Payroll calculates PAYE, pension and NHF and exports for the bank. Timetables solve themselves and flag what won't fit.",
  },
  {
    icon: UsersIcon,
    title: "Parents inside the tent",
    body: "Every family sees their own child's attendance, results, invoices and documents — continuously, not once a term. Appointment slots let parents book themselves. Informed parents stay enrolled.",
  },
  {
    icon: CheckIcon,
    title: "Built for Nigeria, not translated for it",
    body: "Naira-first with kobo-exact accounting. Paystack settlement. PAYE bands, pension and NHF in payroll. WAEC/JAMB-style computer-based testing. NDPR consent, retention and data-subject rights.",
  },
];

const COMPARISON: [string, string, string][] = [
  ["Fee collection", "Cash and teller slips, with leakage", "Online, receipted, settled to your bank"],
  ["Who knows who owes", "The bursar's notebook", "You, in real time, with ageing reports"],
  ["Results", "Computed by hand, evenings lost", "Auto-computed, approval-governed"],
  ["Report cards", "Handwritten, days per class", "Generated in minutes, branded, delivered"],
  ["Attendance", "A paper register", "Digital, with same-day guardian alerts"],
  ["Exams", "Paper, malpractice-prone", "Server-authoritative CBT, per-student papers"],
  ["Parent contact", "Termly, or never", "Continuous portal, alerts and messaging"],
  ["Payroll", "Spreadsheet and prayer", "PAYE, pension and NHF automated"],
  ["Records", "Cabinets that can burn", "Encrypted, backed up, audit-logged"],
  ["Fraud controls", "Trust", "Separation of duties on every money movement"],
  ["Proof of what happened", "Nobody's word against anybody's", "An immutable audit trail of every action"],
];

const RETURNS: { title: string; body: string }[] = [
  { title: "Recovered leakage", body: "Schools moving from cash to receipted online collection routinely find the gap between fees charged and fees banked. That gap becomes yours again." },
  { title: "Faster collection", body: "One-click payment, automatic receipts and visible arrears shorten the cycle. The ageing report turns “we think people owe us” into a work list." },
  { title: "New income", body: "Paid online admission forms, and a public directory profile that markets your school to parents already searching." },
  { title: "Lower cost", body: "Fewer hours on results, report cards, payroll and reconciliation is real money — and your best staff stop drowning in clerical work." },
  { title: "Retention and growth", body: "Informed parents stay. A transparent school out-competes the one down the road. Your board sees dashboards, not anecdotes." },
  { title: "A free term for referrals", body: "Refer another school; when they subscribe, both schools earn a free term. Your network becomes your discount." },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Apply online", body: "Ten minutes. Tell us about your school and pick a plan." },
  { title: "We provision your school", body: "Your administrator and principal receive secure set-password links — never passwords by email." },
  { title: "Bulk-import your students", body: "From a simple CSV. Accounts are created with one-time credentials and printable login slips; every student sets their own password at first login." },
  { title: "Set up your structure", body: "Classes, subjects, teachers and fee items — guided by a built-in help manual written for all seventeen roles." },
  { title: "Go live", body: "Issue your first invoices, take your first register, publish your first results. Most schools finish inside a week." },
];

const FAQS: [string, string][] = [
  ["Where does the fee money go?", "Directly to your school's bank account through gateway settlement. The platform never holds your funds."],
  ["What if we stop paying?", "Your data is never destroyed and your plan is never erased. Access narrows to the core teaching tier after a grace period, and full access restores the moment payment lands. Financial and academic records are append-only throughout."],
  ["Can our data leak to another school?", "The database itself enforces school isolation on every row of every table, verified by automated tests on every release. A cross-school access attempt does not even learn that a record exists."],
  ["Do we need special hardware?", "No. Any browser on any device. The student app installs like a mobile app and tolerates poor connectivity. Biometric attendance devices are supported if you already have them, never required."],
  ["What about our existing records?", "Bulk student import is built in, and onboarding support covers migrating your current term's structure."],
  ["Who can see children's data?", "Nobody without a role-based, audited reason. Medical records are encrypted at the field level and every access is logged. Integrity telemetry is retention-bounded and purged on schedule."],
];

export default function ForOwnersPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      {/* ---------------- Hero: the owner's problem, named plainly ------------- */}
      <section className="border-b border-border/60 bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            For proprietors, owners &amp; boards
          </p>
          <h1 className="mt-4 max-w-3xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Run your school like the institution you want it to become
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Every term, your school loses money it never sees, hours it never gets back, and trust it
            never knew it was spending. MAESTRO-SMS replaces the paper, the spreadsheets and the cash
            with one secure platform — and gives you the internal controls to prove it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/onboard">
              <Button size="lg">Start your 30-day free trial</Button>
            </Link>
            <Link href="/#plans">
              <Button size="lg" variant="outline">See plans and pricing</Button>
            </Link>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {["Fees settle to your own bank", "No setup fee", "Live inside a week"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-brand2" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------- What the traditional approach costs ----------------- */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">What the old way actually costs you</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Most schools run on some mix of paper registers, exercise books, spreadsheets, WhatsApp groups
          and cash. It works — until it doesn&apos;t.
        </p>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {PROBLEMS.map((p) => (
            <Card key={p.cost}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{p.cost}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed text-muted-foreground">{p.detail}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------------- The six pillars ------------------------------------- */}
      <section className="border-y border-border/60 bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">What you get instead</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map((p) => {
              const Icon = p.icon;
              return (
                <div key={p.title} className="rounded-xl border border-border/60 bg-background p-6">
                  <Icon className="h-5 w-5 text-primary" aria-hidden />
                  <h3 className="mt-4 text-base font-semibold">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Side-by-side comparison ----------------------------- */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Side by side</h2>
        <div className="mt-8 overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground"> </th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Traditional</th>
                <th className="px-4 py-3 font-medium text-primary">MAESTRO-SMS</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map(([area, before, after]) => (
                <tr key={area} className="border-b border-border/40 last:border-0">
                  <td className="px-4 py-3 font-medium">{area}</td>
                  <td className="px-4 py-3 text-muted-foreground">{before}</td>
                  <td className="px-4 py-3">{after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- The financial case ---------------------------------- */}
      <section className="border-y border-border/60 bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">The financial case</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {RETURNS.map((r) => (
              <div key={r.title} className="border-l-2 border-brand2 pl-4">
                <h3 className="text-sm font-semibold">{r.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{r.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Pricing is <strong className="font-semibold text-foreground">per active student</strong> — you pay for the
            school you actually are, not a licence tier you grow into. {PLAN_COUNT_WORD} plans let you start with core
            academics and finance, then switch on hostel, transport, CBT and group features as you need them.
            Committing per term saves {CYCLE_DISCOUNT_PERCENT.TERM}%, and per academic year saves{" "}
            {CYCLE_DISCOUNT_PERCENT.YEAR}%. Current pricing is always published on our website — there are no hidden
            quotes.
          </p>
        </div>
      </section>

      {/* ---------------- Onboarding ------------------------------------------ */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Live in days, not months</h2>
        <ol className="mt-8 grid gap-6 md:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {i + 1}
              </span>
              <h3 className="mt-3 text-sm font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------- FAQ -------------------------------------------------- */}
      <section className="border-t border-border/60 bg-muted/30">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Questions owners ask</h2>
          <dl className="mt-8 divide-y divide-border/60">
            {FAQS.map(([q, a]) => (
              <div key={q} className="py-5">
                <dt className="font-medium">{q}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ---------------- Close ------------------------------------------------ */}
      <section className="border-t border-border/60">
        <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8">
          <h2 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Bring one term&apos;s fee collection onto the platform
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Let the receivables report make the argument for everything else. Your first 30 days are on us.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/onboard">
              <Button size="lg">Request onboarding</Button>
            </Link>
            <Link href="/schools">
              <Button size="lg" variant="outline">Browse schools already on it</Button>
            </Link>
          </div>
          <p className="mt-10 text-sm text-muted-foreground">
            Prefer to talk it through?{" "}
            <a href="mailto:support@majormaestro.com" className="font-medium text-primary hover:underline">
              support@majormaestro.com
            </a>{" "}
            or{" "}
            <a
              href="https://wa.me/2349039586647"
              className="font-medium text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsApp +234 903 958 6647
            </a>
          </p>
          <p className="mt-8 text-xs text-muted-foreground">
            MAESTRO-SMS — powered by MajorGBN Innovations Limited
          </p>
        </div>
      </section>
    </div>
  );
}
