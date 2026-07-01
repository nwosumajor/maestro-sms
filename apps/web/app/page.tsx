import Link from "next/link";
import {
  GraduationCapIcon,
  ShieldCheckIcon,
  ScrollTextIcon,
  KeyRoundIcon,
  BookOpenIcon,
  UsersIcon,
  WalletIcon,
  MessagesSquareIcon,
  HeartPulseIcon,
  ArrowRightIcon,
  CheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OnboardForm } from "@/components/public/OnboardForm";

export const metadata = {
  title: "School Management System — run your whole school from one secure register",
  description:
    "Admissions to alumni: classes, attendance, results, fees, HR, transport and approvals for your whole school. Multi-tenant, NDPR-aligned, audit-logged. Onboard your school or apply as a parent.",
};

// =============================================================================
// PUBLIC landing page (no auth) — "The Register" direction.
// Job: convince a school leader to request onboarding (and reassure parents),
// then capture the request via the embedded OnboardForm (#onboard).
// =============================================================================

// Ruled-grid (exercise-book) texture — the signature motif, also on /login.
const RULE_GRID: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(hsl(var(--foreground) / 0.05) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.05) 1px, transparent 1px)",
  backgroundSize: "34px 34px",
};

const MODULE_GROUPS: { label: string; icon: typeof BookOpenIcon; items: [string, string][] }[] = [
  {
    label: "Teaching & Learning",
    icon: BookOpenIcon,
    items: [
      ["Classes & LMS", "Course content, lessons, quizzes and forums per class."],
      ["Gradebook", "Record results with a full, auditable grade history."],
      ["Timetabling", "Periods, rooms and lessons with clash detection."],
      ["Assessment integrity", "Cheating signals for teacher review — never an automatic verdict."],
      ["Library", "Barcode catalogue, loans and fines."],
      ["Certificates & ID", "Generate ID cards and certificates on demand."],
    ],
  },
  {
    label: "People & Records",
    icon: UsersIcon,
    items: [
      ["Student information", "Profiles, contacts and encrypted medical records."],
      ["Attendance", "Daily registers; guardians notified on absence."],
      ["HR & Payroll", "Staff records, leave, appraisals and Nigerian-PAYE payroll."],
      ["Admissions", "Public applications through to staff review and offers."],
      ["Alumni", "Keep former-student records and send broadcasts."],
    ],
  },
  {
    label: "Money & Operations",
    icon: WalletIcon,
    items: [
      ["Fees & Billing", "Invoices, online payments and receipts in exact kobo."],
      ["Document vault", "Report cards and receipts, stored and shared securely."],
      ["Hostel", "Boarding houses, rooms, allocations and rent."],
      ["Transport", "Vehicles, routes, stops and transport fees."],
      ["Approvals", "Multi-stage workflows with separation of duties."],
    ],
  },
  {
    label: "Community",
    icon: MessagesSquareIcon,
    items: [
      ["Messaging", "Two-way threads between staff, parents and students."],
      ["Calendar", "School events for the right audience."],
      ["Discussion hub", "Moderated topic groups for your community."],
      ["Polls", "Anonymous opinion polls."],
      ["Form builder", "Surveys, feedback and review forms."],
      ["Tasks", "Assign and track work for staff and students."],
    ],
  },
  {
    label: "Wellbeing & Insight",
    icon: HeartPulseIcon,
    items: [
      ["Discipline room", "Complaints, evidence and resolution — handled by people."],
      ["Analytics", "Attendance, collection and operations at a glance."],
      ["Games", "A competitive learning arena across classes and schools."],
    ],
  },
];

const SECURITY = [
  {
    icon: ShieldCheckIcon,
    title: "Three layers of tenant isolation",
    body: "Every school's data is separated at the token, the application guard, and Postgres row-level security — never just one.",
  },
  {
    icon: ScrollTextIcon,
    title: "Audit-logged end to end",
    body: "Every record read and change is logged with who, what and when — the accountability minors' data deserves.",
  },
  {
    icon: KeyRoundIcon,
    title: "Least-privilege roles",
    body: "Eleven roles see only what their job needs, backed by MFA, step-up re-auth and just-in-time elevation.",
  },
  {
    icon: GraduationCapIcon,
    title: "NDPR-aligned by default",
    body: "Consent, retention windows and data-subject exports are built in, not bolted on — and integrity tooling only ever flags for human review.",
  },
];

const AUDIENCES = [
  {
    eyebrow: "For school leaders",
    title: "The whole school on one screen",
    points: [
      "Attendance, fees, results and approvals in real time",
      "HR, payroll and leave with maker-checker controls",
      "Turn modules on or off to fit your budget",
    ],
    cta: { label: "Onboard your school", href: "#onboard" },
  },
  {
    eyebrow: "For teachers",
    title: "Less paperwork, more teaching",
    points: [
      "Take the register and grade in a few taps",
      "Message parents and share documents securely",
      "See integrity signals you decide how to act on",
    ],
    cta: { label: "See the modules", href: "#modules" },
  },
  {
    eyebrow: "For parents",
    title: "Stay close to your child's day",
    points: [
      "Follow attendance, results, fees and messages",
      "Pay fees online and download receipts",
      "Find a school and apply for your child online",
    ],
    cta: { label: "Browse schools", href: "/schools" },
  },
];

const PLANS = [
  { name: "Standard", price: 200, modules: 8, tagline: "Core teaching essentials", highlight: false },
  { name: "Premium", price: 350, modules: 18, tagline: "Operations, money & engagement", highlight: true },
  { name: "Ultimate", price: 500, modules: 23, tagline: "Facilities & full student lifecycle", highlight: false },
  { name: "Enterprise", price: 750, modules: 25, tagline: "Everything, including HR & payroll", highlight: false },
];

const STEPS = [
  ["Request onboarding", "Tell us about your school using the form below. It takes about two minutes."],
  ["We provision your tenant", "Our team sets up your isolated school space with an administrator and a principal account."],
  ["Your team goes live", "Add staff and students, switch on the modules you need, and start running your school."],
];

function NavBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-xs ring-1 ring-inset ring-white/10">
            S
          </span>
          <span className="text-sm font-semibold tracking-tight">School Management System</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground md:flex">
          <a href="#modules" className="transition-colors hover:text-foreground">Modules</a>
          <a href="#security" className="transition-colors hover:text-foreground">Security</a>
          <a href="#plans" className="transition-colors hover:text-foreground">Plans</a>
          <Link href="/schools" className="transition-colors hover:text-foreground">For parents</Link>
        </nav>
        <div className="flex items-center gap-2.5">
          <Link
            href="/login"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            Sign in
          </Link>
          <a href="#onboard">
            <Button size="sm">Onboard your school</Button>
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div aria-hidden className="pointer-events-none absolute inset-0" style={RULE_GRID} />
      <div aria-hidden className="pointer-events-none absolute -right-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-primary/10 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div className="animate-fade-up">
          <p className="eyebrow">Multi-tenant school operating system</p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.4rem]">
            Run your entire school from one secure register.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Admissions to alumni — classes, attendance, results, fees, HR, transport and approvals for your
            whole school. Built multi-tenant, with student-data privacy and least-privilege access at its core.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#onboard"><Button size="lg">Onboard your school</Button></a>
            <a href="#modules"><Button size="lg" variant="outline">Explore the 25 modules</Button></a>
          </div>
          <ul className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-muted-foreground">
            {["Tenant-isolated", "NDPR-aligned", "Audit-logged", "Role-based access"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <CheckIcon className="h-3.5 w-3.5 text-primary" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <ConsoleMock />
      </div>
    </section>
  );
}

// An abstract, on-brand glimpse of the product (built from divs, not a screenshot).
function ConsoleMock() {
  const stats: [string, string][] = [
    ["Attendance", "96.4%"],
    ["Fees collected", "₦4.2m"],
    ["Active students", "1,284"],
  ];
  const bars = [40, 64, 52, 78, 70, 88, 60];
  const groups: [string, number][] = [["Overview", 3], ["Teaching", 3], ["People", 2]];
  return (
    <div className="animate-fade-up overflow-hidden rounded-2xl border border-border/70 bg-card shadow-pop">
      <div className="flex items-center gap-2 border-b border-border/70 bg-sidebar px-4 py-3">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[0.65rem] font-bold text-primary-foreground">G</span>
        <span className="text-xs font-semibold">Greenwood High</span>
        <span className="eyebrow ml-auto text-[0.55rem]">Term dashboard</span>
      </div>
      <div className="grid grid-cols-[88px_1fr]">
        <div className="space-y-3 border-r border-border/70 bg-sidebar/60 p-3">
          {groups.map(([g, n]) => (
            <div key={g}>
              <p className="eyebrow text-[0.5rem]">{g}</p>
              <div className="mt-1 space-y-1">
                {Array.from({ length: n }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 rounded-full ${i === 0 && g === "Overview" ? "bg-primary/70" : "bg-muted-foreground/20"}`}
                    style={{ width: `${70 - i * 12}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-3 gap-2">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                <p className="eyebrow text-[0.5rem]">{label}</p>
                <p className="tnum mt-1 text-sm font-semibold tracking-tight">{value}</p>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="flex items-center justify-between">
              <p className="eyebrow text-[0.5rem]">Fee collection · this term</p>
              <span className="tnum text-[0.6rem] font-medium text-primary">+12%</span>
            </div>
            <div className="mt-3 flex h-20 items-end gap-1.5">
              {bars.map((h, i) => (
                <div key={i} className="flex-1 rounded-t bg-primary/80" style={{ height: `${h}%`, opacity: 0.45 + (h / 100) * 0.55 }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBand() {
  const stats: [string, string][] = [
    ["25", "modules"],
    ["4", "plans, per-seat"],
    ["11", "built-in roles"],
    ["50+", "schools per deployment"],
  ];
  return (
    <section className="border-b border-border/60 bg-card">
      <div className="mx-auto grid max-w-6xl grid-cols-2 px-5 sm:px-8 md:grid-cols-4">
        {stats.map(([n, label]) => (
          <div key={label} className="px-2 py-8 text-center">
            <p className="tnum text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{n}</p>
            <p className="mt-1 text-sm text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Security() {
  return (
    <section id="security" className="scroll-mt-20 border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Trust &amp; safety</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Built for the data you&apos;re trusted with.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            A school holds some of the most sensitive data there is — children&apos;s records. Security isn&apos;t a
            feature here; it&apos;s the foundation every module is built on.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {SECURITY.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.title} className="rounded-xl border border-border/70 bg-card p-6 shadow-card transition-shadow hover:shadow-elevated">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Modules() {
  return (
    <section id="modules" className="scroll-mt-20 border-b border-border/60 bg-card">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Everything your school runs on</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Twenty-five modules, organised like a well-kept register.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Start with the essentials and add what you need. Every module is tenant-isolated,
            relationship-scoped and audit-logged — the same standard, across the board.
          </p>
        </div>
        <div className="mt-12 space-y-10">
          {MODULE_GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <div key={group.label}>
                <div className="flex items-center gap-2.5 border-b border-border pb-3">
                  <Icon className="h-4 w-4 text-primary" aria-hidden />
                  <h3 className="eyebrow text-foreground/80">{group.label}</h3>
                  <span className="tnum ml-auto text-xs text-muted-foreground">{group.items.length}</span>
                </div>
                <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map(([name, desc]) => (
                    <div key={name}>
                      <p className="text-sm font-semibold tracking-tight">{name}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Audiences() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="grid gap-5 lg:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div key={a.eyebrow} className="flex flex-col rounded-xl border border-border/70 bg-card p-7 shadow-card">
              <p className="eyebrow text-primary">{a.eyebrow}</p>
              <h3 className="mt-2 text-xl font-semibold tracking-tight">{a.title}</h3>
              <ul className="mt-5 space-y-2.5 text-sm text-muted-foreground">
                {a.points.map((p) => (
                  <li key={p} className="flex gap-2.5">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
              {a.cta.href.startsWith("#") ? (
                <a href={a.cta.href} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                  {a.cta.label} <ArrowRightIcon className="h-4 w-4" aria-hidden />
                </a>
              ) : (
                <Link href={a.cta.href} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                  {a.cta.label} <ArrowRightIcon className="h-4 w-4" aria-hidden />
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Plans() {
  return (
    <section id="plans" className="scroll-mt-20 border-b border-border/60 bg-card">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Simple, per-student pricing</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Pay for the students you have, on the plan that fits.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Billed per active student, per month. Move up a tier the moment you need more — your school keeps
            everything it already had.
          </p>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => (
            <div
              key={p.name}
              className={
                "relative flex flex-col rounded-xl border bg-background p-6 transition-shadow " +
                (p.highlight
                  ? "border-primary/40 shadow-elevated ring-1 ring-primary/20"
                  : "border-border/70 shadow-card hover:shadow-elevated")
              }
            >
              {p.highlight && (
                <span className="absolute -top-2.5 left-6 rounded-full bg-primary px-2.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-primary-foreground">
                  Most popular
                </span>
              )}
              <p className="text-sm font-semibold tracking-tight">{p.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{p.tagline}</p>
              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-xs text-muted-foreground">₦</span>
                <span className="tnum text-3xl font-semibold tracking-tight">{p.price}</span>
                <span className="text-xs text-muted-foreground">/student/mo</span>
              </p>
              <p className="tnum mt-4 text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{p.modules}</span> modules included
              </p>
              <a href="#onboard" className="mt-6">
                <Button variant={p.highlight ? "default" : "outline"} className="w-full">
                  Get started
                </Button>
              </a>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Prices in Nigerian naira. Annual and per-term billing available. Your school owner controls which
          modules are switched on.
        </p>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <p className="eyebrow">How onboarding works</p>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          From request to running your school — in three steps.
        </h2>
        <ol className="mt-12 grid gap-8 md:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="tnum text-sm font-semibold text-primary">0{i + 1}</span>
              <div className="mt-2 h-px w-full bg-border" />
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Onboard() {
  return (
    <section id="onboard" className="relative scroll-mt-20 overflow-hidden border-b border-border/60 bg-primary text-primary-foreground">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12]" style={RULE_GRID} />
      <div aria-hidden className="pointer-events-none absolute -left-32 bottom-0 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 lg:grid-cols-2">
        <div>
          <p className="eyebrow text-primary-foreground/70">Onboard your school</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Bring your school online in days, not terms.
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-primary-foreground/80">
            Send us your details and our team provisions your isolated tenant with an administrator and a
            principal account. There&apos;s no charge to get set up, and no card required to start.
          </p>
          <ul className="mt-7 space-y-2.5 text-sm text-primary-foreground/90">
            {["Your own isolated, audit-logged space", "Admin and principal accounts created for you", "Switch modules on as you grow"].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <CheckIcon className="h-4 w-4 shrink-0" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-card p-6 text-card-foreground shadow-pop sm:p-8">
          <h3 className="text-lg font-semibold tracking-tight">Request onboarding</h3>
          <p className="mt-1 text-sm text-muted-foreground">Takes about two minutes. We&apos;ll be in touch by email.</p>
          <div className="mt-5">
            <OnboardForm />
          </div>
        </div>
      </div>
    </section>
  );
}

function ParentBand() {
  return (
    <section className="border-b border-border/60 bg-card">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-5 px-5 py-12 sm:px-8 md:flex-row md:items-center">
        <div>
          <p className="eyebrow text-primary">For parents</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
            Looking for a school for your child?
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Browse onboarded schools and submit an application online — you&apos;ll be notified once it&apos;s reviewed.
          </p>
        </div>
        <div className="flex shrink-0 gap-3">
          <Link href="/schools"><Button variant="outline">Browse schools</Button></Link>
          <Link href="/apply"><Button>Apply now</Button></Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-12 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">S</span>
          <span className="text-sm font-semibold tracking-tight">School Management System</span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <a href="#modules" className="hover:text-foreground">Modules</a>
          <a href="#security" className="hover:text-foreground">Security</a>
          <a href="#plans" className="hover:text-foreground">Plans</a>
          <Link href="/schools" className="hover:text-foreground">Browse schools</Link>
          <Link href="/login" className="hover:text-foreground">Sign in</Link>
        </nav>
      </div>
      <div className="border-t border-border/60">
        <p className="mx-auto max-w-6xl px-5 py-5 text-xs text-muted-foreground sm:px-8">
          Multi-tenant, NDPR-aligned and audit-logged. Built with least-privilege access and student-data
          privacy at its core.
        </p>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <NavBar />
      <Hero />
      <StatBand />
      <Security />
      <Modules />
      <Audiences />
      <Plans />
      <Steps />
      <Onboard />
      <ParentBand />
      <Footer />
    </main>
  );
}
