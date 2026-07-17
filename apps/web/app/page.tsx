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
  QuoteIcon,
  StarIcon,
  ClipboardListIcon,
  ServerCogIcon,
  RocketIcon,
  // per-module icons for the "register" grid
  CalendarClockIcon,
  ScanFaceIcon,
  LibraryIcon,
  AwardIcon,
  UserIcon,
  CalendarCheckIcon,
  BriefcaseIcon,
  UserPlusIcon,
  UsersRoundIcon,
  ReceiptIcon,
  FolderLockIcon,
  BedDoubleIcon,
  BusIcon,
  WorkflowIcon,
  CalendarDaysIcon,
  MessageCircleIcon,
  VoteIcon,
  ListChecksIcon,
  ListTodoIcon,
  GavelIcon,
  BarChart3Icon,
  Gamepad2Icon,
  MonitorCheckIcon,
  Building2Icon,
} from "lucide-react";
import {
  BILLING_CYCLES,
  CURRENCY_SYMBOL,
  CYCLE_DISCOUNT_PERCENT,
  CYCLE_MONTHS,
  MODULE_CATALOG,
  PLANS as PLAN_KEYS,
  PLAN_MODULES,
  PLAN_PRICING_BY_CURRENCY,
  applyCycleDiscountMinor,
  defaultCurrencyFor,
  type Plan,
  type PlanPriceDto,
} from "@sms/types";
import { Button } from "@/components/ui/button";
import { HeroCarousel } from "@/components/public/HeroCarousel";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

// Auto-sliding hero photos — polished, international education imagery.
const HERO_IMAGES = [
  { src: "/images/hero-1.jpg", alt: "A diverse group of pupils working together in a bright, modern classroom" },
  { src: "/images/hero-2.jpg", alt: "A landmark university campus building under a clear sky" },
  { src: "/images/hero-3.jpg", alt: "A pupil raising their hand to answer in class" },
  { src: "/images/hero-4.jpg", alt: "A classical university hall on a green campus" },
];

// Sliding background for the onboarding CTA — celebratory, aspirational imagery.
const ONBOARD_IMAGES = [
  { src: "/images/onboard-1.jpg", alt: "" },
  { src: "/images/onboard-2.jpg", alt: "" },
  { src: "/images/onboard-3.jpg", alt: "" },
];

// "See it in action" carousel — multiple app surfaces (dashboard, LMS, analytics,
// gradebook), rendered from the app's own design tokens at a shared 1800x1184.
const PRODUCT_IMAGES = [
  { src: "/images/product-dashboard.jpg", alt: "The term dashboard — attendance, fees, approvals and recent activity" },
  { src: "/images/product-lms.jpg", alt: "The Student LMS — course lessons, a video lesson, quizzes and assignments" },
  { src: "/images/product-analytics.jpg", alt: "School analytics — attendance trend, enrolment and fee-collection charts" },
  { src: "/images/product-gradebook.jpg", alt: "The gradebook — a term scoresheet with component marks, grades and positions" },
];

// Auto-scrolling "life on the platform" strip — arch-framed portrait tiles.
const MARQUEE_IMAGES = [
  { src: "/images/marquee-1.jpg", alt: "A pupil exploring with a magnifying glass" },
  { src: "/images/marquee-2.jpg", alt: "A student in a science lab wearing safety goggles" },
  { src: "/images/marquee-3.jpg", alt: "Children smiling at their easels in an art class" },
  { src: "/images/marquee-4.jpg", alt: "A pupil painting at an easel" },
  { src: "/images/marquee-5.jpg", alt: "A student looking through a microscope" },
  { src: "/images/marquee-6.jpg", alt: "Three students reading together" },
  { src: "/images/marquee-7.jpg", alt: "Two students reading a book in the library" },
  { src: "/images/marquee-8.jpg", alt: "Two pupils in uniform reading together" },
];

export const metadata = {
  title: "School Management System — run your whole school from one secure register",
  description:
    "Admissions to alumni: classes, attendance, results, fees, HR, transport and approvals for your whole school. Multi-tenant, NDPR-aligned, audit-logged. Onboard your school or apply as a parent.",
};

// =============================================================================
// PUBLIC landing page (no auth) — "The Register" direction.
// Job: convince a school leader to request onboarding (and reassure parents),
// then send them to the dedicated /onboard intake page (#onboard links to it).
// =============================================================================

// Ruled-grid (exercise-book) texture — the signature motif, also on /login.
const RULE_GRID: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(hsl(var(--foreground) / 0.05) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.05) 1px, transparent 1px)",
  backgroundSize: "34px 34px",
};

type ModuleItem = { name: string; desc: string; icon: typeof BookOpenIcon };
const MODULE_GROUPS: { label: string; icon: typeof BookOpenIcon; items: ModuleItem[] }[] = [
  {
    label: "Teaching & Learning",
    icon: BookOpenIcon,
    items: [
      { name: "Classes & LMS", desc: "Course content, lessons, quizzes and forums per class.", icon: BookOpenIcon },
      { name: "Gradebook", desc: "Record results with a full, auditable grade history.", icon: GraduationCapIcon },
      { name: "Timetabling", desc: "Periods, rooms and lessons with clash detection.", icon: CalendarClockIcon },
      { name: "Assessment integrity", desc: "Cheating signals for teacher review — never an automatic verdict.", icon: ScanFaceIcon },
      { name: "CBT exam hall", desc: "Timed, auto-marked WAEC/JAMB-style mock exams with question banks.", icon: MonitorCheckIcon },
      { name: "Library", desc: "Barcode catalogue, loans and fines.", icon: LibraryIcon },
      { name: "Certificates & ID", desc: "Generate ID cards and certificates on demand.", icon: AwardIcon },
    ],
  },
  {
    label: "People & Records",
    icon: UsersIcon,
    items: [
      { name: "Student information", desc: "Profiles, contacts and encrypted medical records.", icon: UserIcon },
      { name: "Attendance", desc: "Daily registers; guardians notified on absence.", icon: CalendarCheckIcon },
      { name: "HR & Payroll", desc: "Staff records, leave, appraisals and Nigerian-PAYE payroll.", icon: BriefcaseIcon },
      { name: "Admissions", desc: "Public applications through to staff review and offers.", icon: UserPlusIcon },
      { name: "Alumni", desc: "Keep former-student records and send broadcasts.", icon: UsersRoundIcon },
    ],
  },
  {
    label: "Money & Operations",
    icon: WalletIcon,
    items: [
      { name: "Fees & Billing", desc: "Invoices, card payments and receipts — settled straight to your school's bank.", icon: ReceiptIcon },
      { name: "Document vault", desc: "Report cards and receipts, stored and shared securely.", icon: FolderLockIcon },
      { name: "Hostel", desc: "Boarding houses, rooms, allocations and rent.", icon: BedDoubleIcon },
      { name: "Transport", desc: "Vehicles, routes, stops and transport fees.", icon: BusIcon },
      { name: "Approvals", desc: "Multi-stage workflows with separation of duties.", icon: WorkflowIcon },
      { name: "Group console", desc: "One dashboard across every campus for multi-school proprietors.", icon: Building2Icon },
    ],
  },
  {
    label: "Community",
    icon: MessagesSquareIcon,
    items: [
      { name: "Messaging", desc: "Two-way threads between staff, parents and students.", icon: MessagesSquareIcon },
      { name: "Calendar", desc: "School events for the right audience.", icon: CalendarDaysIcon },
      { name: "Discussion hub", desc: "Moderated topic groups for your community.", icon: MessageCircleIcon },
      { name: "Polls", desc: "Anonymous opinion polls.", icon: VoteIcon },
      { name: "Form builder", desc: "Surveys, feedback and review forms.", icon: ListChecksIcon },
      { name: "Tasks", desc: "Assign and track work for staff and students.", icon: ListTodoIcon },
    ],
  },
  {
    label: "Wellbeing & Insight",
    icon: HeartPulseIcon,
    items: [
      { name: "Discipline room", desc: "Complaints, evidence and resolution — handled by people.", icon: GavelIcon },
      { name: "Analytics", desc: "Attendance, collection and operations at a glance.", icon: BarChart3Icon },
      { name: "Games", desc: "A competitive learning arena across classes and schools.", icon: Gamepad2Icon },
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
    body: "Seventeen roles see only what their job needs, backed by MFA, step-up re-auth and just-in-time elevation.",
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
    img: "/images/audience-leaders.jpg",
    alt: "A smiling teacher standing at the whiteboard in a classroom",
    points: [
      "Attendance, fees, results and approvals in real time",
      "Online fee payments settle directly to your school's bank",
      "HR, payroll and leave with maker-checker controls",
      "Turn modules on or off to fit your budget",
    ],
    cta: { label: "Onboard your school", href: "#onboard" },
  },
  {
    eyebrow: "For teachers",
    title: "Less paperwork, more teaching",
    img: "/images/audience-teachers.jpg",
    alt: "A teacher taking a lesson as a pupil raises their hand to answer",
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
    img: "/images/audience-parents.jpg",
    alt: "A parent holding their child's hands, seated together outdoors",
    points: [
      "Follow attendance, results, fees and messages",
      "Pay fees online and download receipts",
      "Find a school and apply for your child online",
    ],
    cta: { label: "Browse schools", href: "/schools" },
  },
];

// Copy is local; PRICES + module counts are DERIVED — fetched from the same
// operator-overridable effective pricing checkout charges (fallback: the
// platform constants), so this page can never drift from the real bill.
const PLAN_META: Record<Plan, { tagline: string; highlight: boolean }> = {
  STANDARD: { tagline: "Core teaching essentials", highlight: false },
  PREMIUM: { tagline: "Operations, money & engagement", highlight: true },
  ULTIMATE: { tagline: "Facilities & full student lifecycle", highlight: false },
  ENTERPRISE: { tagline: "Everything, including HR & payroll", highlight: false },
};

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/** Whole numbers stay whole (₦1,425); fractional amounts get 2dp (₦2,137.50). */
function fmtAmount(n: number): string {
  return n.toLocaleString("en-NG", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

async function effectivePlans() {
  let rows: PlanPriceDto[] | null = null;
  try {
    // no-store: an operator price change must show on the very next page view —
    // the Next data-cache window here (revalidate) hid updates for minutes. The
    // per-request cost is one API call answered from PlanPricingService's
    // in-memory cache (dropped instantly on write, incl. across replicas).
    const res = await fetch(`${API_BASE}/public/plan-pricing`, { cache: "no-store" });
    if (res.ok) rows = (await res.json()) as PlanPriceDto[];
  } catch {
    // API unreachable (e.g. static build) -> platform default pricing below.
  }
  return (Object.values(PLAN_KEYS) as Plan[]).map((plan) => {
    // Each tier displays in its DEFAULT currency: ₦ locally, $ for ENTERPRISE
    // (USD-only — it targets international schools). Rows are per-currency.
    const currency = defaultCurrencyFor(plan);
    const row = rows?.find((r) => r.plan === plan && r.currency === currency);
    const fallback = PLAN_PRICING_BY_CURRENCY[currency][plan].perSeatMonthlyMinor;
    const perSeatMinor = row?.perSeatMonthlyMinor ?? fallback;
    // Cycle marketing: the SAME discount rule checkout charges with (one source).
    const toMajor = (minor: number) => Math.round((minor / 100) * 100) / 100;
    const perStudent = (cycle: keyof typeof CYCLE_MONTHS) =>
      toMajor(applyCycleDiscountMinor(perSeatMinor * CYCLE_MONTHS[cycle], cycle));
    return {
      name: plan.charAt(0) + plan.slice(1).toLowerCase(),
      symbol: CURRENCY_SYMBOL[currency],
      price: toMajor(perSeatMinor),
      termPrice: perStudent(BILLING_CYCLES.TERM),
      yearPrice: perStudent(BILLING_CYCLES.YEAR),
      modules: row?.modulesIncluded ?? PLAN_MODULES[plan].length,
      ...PLAN_META[plan],
    };
  });
}

const STEPS: { icon: typeof ClipboardListIcon; title: string; body: string }[] = [
  {
    icon: ClipboardListIcon,
    title: "Request onboarding",
    body: "Tell us about your school — location, size, and the plan and modules you want. About five minutes, with a live price estimate as you type.",
  },
  {
    icon: ServerCogIcon,
    title: "We provision your tenant",
    body: "We review within 1–2 working days and set up your isolated school space. Your admins receive secure set-password links by email — no passwords ever travel.",
  },
  {
    icon: RocketIcon,
    title: "Your team goes live",
    body: "Bulk-import your students, add staff, and run your first term free for 30 days on the full plan. The in-app guide walks every role through their first week.",
  },
];

// PLACEHOLDER social proof — replace with REAL, attributed quotes from partner
// schools before launch. Kept intentionally generic (role + region, no invented
// school names or people) so nothing fabricated ships as if it were a real
// named endorsement. See the trust chips below for claims that are already true.
const TESTIMONIALS: { quote: string; name: string; role: string }[] = [
  {
    quote:
      "We ran a whole term on it and never touched our spreadsheets again. Attendance, fees and approvals are finally in one place — I can see the entire school before I've had my morning coffee.",
    name: "Principal",
    role: "Secondary school · Lagos",
  },
  {
    quote:
      "Onboarding took days, not a term. Per-student pricing let us start lean and switch on HR and payroll only when we were ready — no big upfront bet, no wasted modules.",
    name: "School administrator",
    role: "Group of schools · Abuja",
  },
  {
    quote:
      "I follow my daughter's attendance and results and pay her fees straight from my phone. Knowing her records are private and secure is exactly the reassurance a parent wants.",
    name: "Parent",
    role: "Primary school · Port Harcourt",
  },
];

// TRUE product claims — safe to show as-is (these are enforced in the codebase).
const TRUST_CHIPS = ["NDPR-aligned", "Audit-logged end to end", "Row-level tenant isolation", "MFA + step-up re-auth"];

function NavBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          {/* Platform default mark (MajorGBN) — a school's own logo appears
              only inside THEIR portal, never here. */}
          <img src="/images/platform-mark.png" alt="MajorGBN" width={128} height={128} className="h-9 w-9 object-contain" />
          <span className="text-sm font-semibold tracking-tight">School Management System</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground md:flex">
          <a href="#modules" className="transition-colors hover:text-foreground">Modules</a>
          <a href="#security" className="transition-colors hover:text-foreground">Security</a>
          <a href="#plans" className="transition-colors hover:text-foreground">Plans</a>
          <Link href="/schools" className="transition-colors hover:text-foreground">For parents</Link>
          <Link href="/careers" className="transition-colors hover:text-foreground">Careers</Link>
        </nav>
        <div className="flex items-center gap-2.5">
          <ThemeToggle className="hidden sm:inline-flex" />
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

// Full-bleed photographic hero: the auto-sliding carousel is the WIDE background,
// with the headline + CTAs overlaid on a legibility gradient. Reads warm and human.
function Hero() {
  const stats: [string, string][] = [
    ["Attendance", "96.4%"],
    ["Fees collected", "₦4.2m"],
    ["Active students", "1,284"],
  ];
  return (
    <section className="relative flex min-h-[34rem] items-center overflow-hidden border-b border-border/60 lg:min-h-[42rem]">
      {/* wide sliding background */}
      <div aria-hidden className="absolute inset-0">
        <HeroCarousel images={HERO_IMAGES} className="h-full w-full" />
      </div>
      {/* legibility overlays — left-heavy for the text, plus top/bottom darkening */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-black/20" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/25" />

      <div className="relative mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="max-w-2xl animate-fade-up text-white">
          <span aria-hidden className="mb-3 block h-px w-12 bg-white/50" />
          <p className="eyebrow text-white/70">Multi-tenant school operating system</p>
          <h1 className="mt-4 font-display text-4xl font-semibold leading-[1.08] tracking-tight drop-shadow-sm sm:text-5xl lg:text-[3.6rem]">
            Run your entire school from one secure register.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/85">
            Admissions to alumni — classes, attendance, results, fees, HR, transport and approvals for your
            whole school. Built multi-tenant, with student-data privacy and least-privilege access at its core.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#onboard"><Button size="lg">Start your 30-day free trial</Button></a>
            <a href="#modules">
              <Button size="lg" variant="outline" className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                Explore the {MODULE_CATALOG.length} modules
              </Button>
            </a>
          </div>
          <p className="mt-3 text-xs text-white/70">
            Full plan from day one · no card required · billed per active student after the trial
          </p>
          <ul className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-white/80">
            {["Fees settle to your bank", "Tenant-isolated", "NDPR-aligned", "Audit-logged", "Role-based access"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <CheckIcon className="h-3.5 w-3.5 text-white" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* floating glass "live" stat card — keeps the real-product feel over the photo */}
      <div className="absolute bottom-6 right-6 z-10 hidden w-64 rounded-xl border border-white/20 bg-white/10 p-3 shadow-elevated backdrop-blur-md lg:block">
        <div className="flex items-center gap-2 text-white">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[0.65rem] font-bold text-primary-foreground">G</span>
          <span className="text-xs font-semibold">Greenwood High</span>
          <span className="eyebrow ml-auto text-[0.55rem] text-white/70">Live</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-white">
          {stats.map(([label, value]) => (
            <div key={label}>
              <p className="eyebrow text-[0.45rem] leading-tight text-white/70">{label}</p>
              <p className="tnum mt-0.5 text-sm font-semibold tracking-tight">{value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StatBand() {
  const stats: [string, string][] = [
    [String(MODULE_CATALOG.length), "modules"],
    ["4", "plans, per-seat"],
    ["17", "built-in roles"],
    ["5,000+", "schools per deployment"],
  ];
  return (
    <section className="relative overflow-hidden border-b border-border/60 bg-card">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.5]" style={RULE_GRID} />
      <div className="relative mx-auto grid max-w-6xl grid-cols-2 px-5 sm:px-8 md:grid-cols-4">
        {stats.map(([n, label]) => (
          <div key={label} className="px-2 py-8 text-center">
            <p className="tnum font-display text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{n}</p>
            <p className="mt-1 text-sm text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// Dark "vault" section — inverts the palette for rhythm and to underline the
// security-serious tone. Bright brand-teal accents + a faint rule-grid texture.
function Security() {
  return (
    <section id="security" className="relative scroll-mt-20 overflow-hidden border-b border-border/60 bg-neutral-950 text-white">
      {/* Photographic depth under the vault — campus imagery, heavily veiled. */}
      <img src="/images/hero-2.jpg" alt="" aria-hidden width={2000} height={1333} loading="lazy" className="absolute inset-0 h-full w-full object-cover opacity-25" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-neutral-950/80 via-neutral-950/85 to-neutral-950/95" />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.06]" style={RULE_GRID} />
      <div aria-hidden className="pointer-events-none absolute -right-40 -top-32 h-[30rem] w-[30rem] rounded-full bg-[hsl(203_70%_45%)]/20 blur-3xl" />
      <div className="relative mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow text-[hsl(203_72%_62%)]">Trust &amp; safety</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Built for the data you&apos;re trusted with.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-white/70">
            A school holds some of the most sensitive data there is — children&apos;s records. Security isn&apos;t a
            feature here; it&apos;s the foundation every module is built on.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {SECURITY.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.title} className="rounded-xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm transition-colors hover:bg-white/[0.07]">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-[hsl(203_72%_62%)]/15 text-[hsl(203_72%_62%)]">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/65">{s.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Modules() {
  let n = 0; // running "register entry" number across all groups (01–27)
  return (
    <section id="modules" className="relative scroll-mt-20 overflow-hidden border-b border-border/60 bg-background">
      {/* exercise-book rule-grid — the "register" motif */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.6]" style={RULE_GRID} />
      <div className="relative mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Everything your school runs on</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Twenty-seven modules, organised like a well-kept register.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Start with the essentials and add what you need. Every module is tenant-isolated,
            relationship-scoped and audit-logged — the same standard, across the board.
          </p>
        </div>
        <div className="mt-14 space-y-12">
          {MODULE_GROUPS.map((group) => {
            const GroupIcon = group.icon;
            return (
              <div key={group.label}>
                {/* ledger-style section divider */}
                <div className="mb-5 flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                    <GroupIcon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="font-display text-lg font-semibold tracking-tight">{group.label}</h3>
                  <span aria-hidden className="h-px flex-1 bg-border" />
                  <span className="tnum shrink-0 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {group.items.length} modules
                  </span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((m) => {
                    n += 1;
                    const Icon = m.icon;
                    return (
                      <div
                        key={m.name}
                        className="group relative flex flex-col rounded-xl border border-border/70 bg-card p-5 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-primary/40 hover:shadow-elevated"
                      >
                        <span className="tnum absolute right-4 top-4 text-[0.7rem] font-semibold text-muted-foreground/40 transition-colors group-hover:text-primary/70">
                          {String(n).padStart(2, "0")}
                        </span>
                        <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-primary-foreground">
                          <Icon className="h-5 w-5" aria-hidden />
                        </span>
                        <p className="mt-4 text-sm font-semibold tracking-tight">{m.name}</p>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.desc}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// "See it in action" — a sliding carousel of app surfaces (PRODUCT_IMAGES),
// each rendered from the app's own design tokens. Swap any slide for a real
// screenshot at the same 1800x1184 aspect.
function ProductShowcase() {
  const features: [string, string][] = [
    ["Everything in real time", "Attendance, fees, results and approvals update live — no end-of-day reconciling."],
    ["Role-aware by design", "Each of the 17 roles sees only what their job needs, backed by MFA and step-up."],
    ["Modules you control", "Switch products on and off to match your budget; billing follows your active students."],
  ];
  const accent = "text-[hsl(203_72%_62%)]";
  return (
    <section
      id="product"
      className="relative scroll-mt-20 overflow-hidden border-b border-border/60 bg-neutral-950 text-white"
    >
      {/* DESKTOP: wide sliding product background + legibility overlay (text on solid
          dark left, product bleeds in from the right). Hidden on mobile — no room to split. */}
      <div aria-hidden className="absolute inset-0 hidden lg:block">
        <HeroCarousel images={PRODUCT_IMAGES} intervalMs={5000} zoom={false} className="h-full w-full" />
      </div>
      <div aria-hidden className="absolute inset-0 hidden bg-gradient-to-r from-neutral-950 from-45% via-neutral-950/80 via-72% to-neutral-950/25 lg:block" />
      <div aria-hidden className="absolute inset-0 hidden bg-gradient-to-t from-neutral-950/60 via-transparent to-neutral-950/35 lg:block" />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-16 sm:px-8 lg:min-h-[46rem] lg:justify-center lg:py-28">
        <div className="max-w-xl animate-fade-up">
          <p className={`eyebrow ${accent}`}>See it in action</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight drop-shadow-sm sm:text-4xl">
            The whole school day on one screen.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-white/80">
            From the leadership dashboard to the student LMS, analytics and the gradebook — one tenant-isolated
            system your whole team works in, instead of switching between tools.
          </p>
          <ul className="mt-7 space-y-4">
            {features.map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <CheckIcon className={`mt-0.5 h-5 w-5 shrink-0 ${accent}`} aria-hidden />
                <div>
                  <p className="text-sm font-semibold tracking-tight text-white">{title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-white/70">{body}</p>
                </div>
              </li>
            ))}
          </ul>
          <a href="#onboard" className={`mt-8 inline-flex items-center gap-1.5 text-sm font-medium ${accent} hover:underline`}>
            Start your free trial <ArrowRightIcon className="h-4 w-4" aria-hidden />
          </a>
          <div className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-white/70">
            {["Leadership dashboard", "Student LMS", "Analytics", "Gradebook"].map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(203_72%_62%)]" />
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* MOBILE/TABLET: framed carousel below the copy, so the product is clearly visible */}
        <div className="lg:hidden">
          <HeroCarousel
            images={PRODUCT_IMAGES}
            intervalMs={5000}
            zoom={false}
            className="aspect-[1800/1184] w-full rounded-xl border border-white/15 shadow-pop"
          />
        </div>
      </div>
    </section>
  );
}

function Testimonials() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      {/* Full-bleed photography — voices over the community they serve. */}
      <img src="/images/audience-parents.jpg" alt="" aria-hidden width={2000} height={1333} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-neutral-950/85 via-neutral-950/75 to-neutral-950/85" />
      <div className="relative mx-auto max-w-6xl px-5 py-20 text-white sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow text-white/70">Trusted with what matters most</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Built for schools that take data seriously.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-white/80">
            Leaders, teachers and parents rely on the same secure register every day — and every one of these
            protections is already switched on, out of the box.
          </p>
          <ul className="mt-6 flex flex-wrap gap-2">
            {TRUST_CHIPS.map((c) => (
              <li key={c} className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-medium text-white">
                <ShieldCheckIcon className="h-3.5 w-3.5" aria-hidden />
                {c}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <figure key={t.quote} className="flex flex-col rounded-xl border border-white/15 bg-white/[0.07] p-6 backdrop-blur-md">
              <QuoteIcon className="h-6 w-6 text-white/40" aria-hidden />
              <div className="mt-3 flex gap-0.5" aria-label="5 out of 5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <StarIcon key={i} className="h-3.5 w-3.5 fill-amber-300 text-amber-300" aria-hidden />
                ))}
              </div>
              <blockquote className="mt-3 flex-1 text-sm leading-relaxed text-white/90">&ldquo;{t.quote}&rdquo;</blockquote>
              <figcaption className="mt-5 border-t border-white/15 pt-4">
                <p className="text-sm font-semibold tracking-tight">{t.name}</p>
                <p className="text-xs text-white/65">{t.role}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

// Auto-scrolling photo strip (pure CSS marquee; track duplicated for a seamless
// loop). Arch-topped tiles + edge fades. Pauses on hover, still under reduced-motion.
function PhotoMarquee() {
  const tiles = [...MARQUEE_IMAGES, ...MARQUEE_IMAGES];
  return (
    <section className="overflow-hidden border-b border-border/60 bg-card py-16">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <p className="eyebrow text-center text-primary">Life across every classroom</p>
        <h2 className="mx-auto mt-2 max-w-2xl text-center font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          One platform for the whole school day — lesson to lab to library.
        </h2>
      </div>
      <div className="group relative mt-10 flex">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-card to-transparent sm:w-28" />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-card to-transparent sm:w-28" />
        <div className="flex shrink-0 animate-marquee gap-4 pr-4 motion-reduce:animate-none group-hover:[animation-play-state:paused]">
          {tiles.map((t, i) => (
            <div
              key={i}
              className="relative h-60 w-44 shrink-0 overflow-hidden rounded-b-lg rounded-t-[3.5rem] border border-border/60 shadow-card"
            >
              <img
                src={t.src}
                alt={i < MARQUEE_IMAGES.length ? t.alt : ""}
                aria-hidden={i >= MARQUEE_IMAGES.length || undefined}
                width={480}
                height={600}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
          ))}
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
            <div key={a.eyebrow} className="group flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-card">
              <div className="relative aspect-[3/2] w-full overflow-hidden">
                <img
                  src={a.img}
                  alt={a.alt}
                  width={900}
                  height={600}
                  loading="lazy"
                  className="h-full w-full object-cover grayscale-[0.45] contrast-[1.03] transition-all duration-500 group-hover:grayscale-0"
                />
                {/* subtle brand duotone — unifies the imagery; reveals full colour on hover */}
                <div aria-hidden className="pointer-events-none absolute inset-0 bg-primary/20 mix-blend-multiply transition-opacity duration-500 group-hover:opacity-0" />
              </div>
              <div className="flex flex-1 flex-col p-7">
              <p className="eyebrow text-primary">{a.eyebrow}</p>
              <h3 className="mt-2 text-xl font-semibold tracking-tight">{a.title}</h3>
              <ul className="mt-5 space-y-2.5 text-sm text-muted-foreground">
                {a.points.map((p) => (
                  <li key={p} className="flex gap-2.5">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand2" aria-hidden />
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
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// The money section — fee collection is the #1 operational pain for school
// owners, and the strongest single reason to buy. Every claim here is enforced
// in the product (split settlement, reminders, receipts, maker-checker).
function RevenueBand() {
  const points: { title: string; body: string }[] = [
    {
      title: "Parents pay by card, from their phone",
      body: "Every invoice carries a pay-online button. No more chasing cash or decoding bank-transfer screenshots.",
    },
    {
      title: "Money lands in YOUR bank account",
      body: "Register your school's account once and Paystack splits every payment straight to it — the platform never holds your fees.",
    },
    {
      title: "Automatic reminders & receipts",
      body: "Guardians are nudged about outstanding balances in-app, by email — and by SMS or WhatsApp with message credits; receipts issue themselves the moment payment lands.",
    },
    {
      title: "Controls your auditor will love",
      body: "Exact-kobo ledgers, no hard-deletes, receivables-aging reports, and a second approver required on large postings and every refund.",
    },
  ];
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      {/* Full-bleed photography — the money story told over real school life. */}
      <img src="/images/audience-leaders.jpg" alt="" aria-hidden width={2000} height={1333} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-neutral-950/90 via-neutral-950/75 to-neutral-950/55" />
      <div className="relative mx-auto max-w-6xl px-5 py-20 text-white sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow text-emerald-300">Get paid faster</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Fee collection that runs itself — settled to your own bank.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-white/80">
            Schools on paper chase fees all term. Here, invoices go out, parents pay online, reminders send
            themselves, and settlements arrive in the school&apos;s own account — with an audit trail behind
            every kobo.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {points.map((pt) => (
            <div key={pt.title} className="rounded-xl border border-white/15 bg-white/[0.07] p-6 backdrop-blur-md transition-colors hover:bg-white/[0.1]">
              <h3 className="flex items-start gap-2.5 text-base font-semibold tracking-tight">
                <CheckIcon className="mt-1 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                {pt.title}
              </h3>
              <p className="mt-2 pl-[1.65rem] text-sm leading-relaxed text-white/75">{pt.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

async function Plans() {
  const plans = await effectivePlans();
  return (
    <section id="plans" className="scroll-mt-20 border-b border-border/60 bg-card">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Simple, per-student pricing</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Pay for the students you have, on the plan that fits.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Billed per active student, per month. Move up a tier the moment you need more — your school keeps
            everything it already had.
          </p>
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand2/30 bg-brand2/10 px-3 py-1 text-xs font-medium text-brand2">
            <CheckIcon className="h-3.5 w-3.5" aria-hidden />
            Every school starts with a 30-day free trial — no card required
          </p>{" "}
          <a
            href="#referral"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand2/30 bg-brand2/10 px-3 py-1 text-xs font-medium text-brand2 transition-colors hover:bg-brand2/20"
          >
            <CheckIcon className="h-3.5 w-3.5" aria-hidden />
            Referred by a school? You BOTH get a free term when you subscribe →
          </a>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => (
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
                <span className="text-xs text-muted-foreground">{p.symbol}</span>
                <span className="tnum font-display text-3xl font-semibold tracking-tight">{p.price}</span>
                <span className="text-xs text-muted-foreground">/student/mo</span>
              </p>
              <p className="tnum mt-2 text-xs text-muted-foreground">
                {p.symbol}{fmtAmount(p.termPrice)}/term <span className="font-medium text-emerald-600 dark:text-emerald-400">(save {CYCLE_DISCOUNT_PERCENT.TERM}%)</span>
                {" · "}
                {p.symbol}{fmtAmount(p.yearPrice)}/year <span className="font-medium text-emerald-600 dark:text-emerald-400">(save {CYCLE_DISCOUNT_PERCENT.YEAR}%)</span>
              </p>
              <p className="tnum mt-3 text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{p.modules}</span> modules included
              </p>
              <a href="#onboard" className="mt-6">
                <Button variant={p.highlight ? "default" : "outline"} className="w-full">
                  Start free trial
                </Button>
              </a>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Standard, Premium and Ultimate are priced in Nigerian naira (card payments via Paystack); Enterprise
          is billed in US dollars (Stripe) for schools worldwide. Pay monthly, per term (3 months — save 5%)
          or per year (3 terms / 9 months — save 15%). No setup fees, change plans any time, and your data is
          never deleted — even if a payment lapses, your school keeps running on the core modules until you renew.
        </p>
      </div>
    </section>
  );
}

function ReferralBand() {
  return (
    <section id="referral" className="scroll-mt-20 border-b border-border/60 bg-background">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="eyebrow text-brand2">Referral programme</p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Give a term, get a term.
            </h2>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
              Know another school that should be here? Share your referral code — when they subscribe to
              any paid plan, <span className="font-semibold text-foreground">both schools get one school
              term (3 months) of platform usage free</span>. Yours is added to your current plan; theirs
              stacks on top of the plan they chose.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
              {[
                "Applied automatically the moment their first subscription payment lands",
                "No limit — every school you refer earns you another free term",
                "Track every referral and reward from your Billing page",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand2" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/login">
                <Button>Get your referral code</Button>
              </Link>
              <Link href="/onboard">
                <Button variant="outline">Been referred? Start here</Button>
              </Link>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Your code lives in Billing → Refer a school. Referred schools enter it on the onboarding
              form — or just use your share link.
            </p>
          </div>
          {/* The offer, stated as the receipt it becomes. */}
          <div className="rounded-xl border border-brand2/30 bg-brand2/[0.06] p-6 shadow-card">
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">When they subscribe</p>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
                <span className="text-sm font-medium">Your school</span>
                <span className="text-sm font-semibold text-brand2">+1 term free · your plan</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
                <span className="text-sm font-medium">The school you referred</span>
                <span className="text-sm font-semibold text-brand2">+1 term free · their plan</span>
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              One school term = 3 months. Rewards extend the paid period directly — no coupons, no forms,
              audit-logged like everything else.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.5]" style={RULE_GRID} />
      <div className="relative mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <p className="eyebrow">How onboarding works</p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          From request to running your school — in three steps.
        </h2>
        <ol className="mt-12 grid gap-8 md:grid-cols-3">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.title} className="relative">
                {/* connector line to the next step (desktop) */}
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="absolute left-12 top-6 hidden h-px w-[calc(100%-2rem)] bg-border md:block" />
                )}
                <div className="flex items-center gap-3">
                  <span className="relative z-10 grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-border/70 bg-card text-primary shadow-xs">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="tnum text-sm font-semibold text-primary">0{i + 1}</span>
                </div>
                <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// Objection handling right before the ask — every answer states enforced,
// verifiable product behaviour (nothing aspirational).
const FAQS: { q: string; a: string }[] = [
  {
    q: "What happens when the 30-day trial ends?",
    a: "You pay per active student — monthly, per term (3 months, 5% off) or per year (9 months, 15% off) — from inside the app, by card, and you can save a card to renew automatically. If you don't pay, nothing is deleted: after a grace period (7 days by default) your school simply runs on the core Standard modules until payment, and your full plan returns the instant you pay.",
  },
  {
    q: "Where does parents' fee money go?",
    a: "Straight to your school's own bank account. You register your settlement account once; every card payment then splits directly to it via Paystack. The platform never warehouses your fees, and any card-processing charge is shown on the payment page before a parent pays.",
  },
  {
    q: "How safe is our students' data?",
    a: "Each school lives in its own isolated tenant enforced at three layers, down to the database rows. Every read and change of student records is audit-logged, medical fields are encrypted at rest, staff use MFA and step-up re-authentication, and NDPR consent, retention and data-export rights are built in.",
  },
  {
    q: "Can we start small and grow?",
    a: "Yes — pricing is per student, and plans can change at any time. Start on Standard, switch on more modules when you're ready, and your data carries over untouched. Downgrading never deletes anything either.",
  },
  {
    q: "We're outside Nigeria — can we use it?",
    a: "Yes. The Enterprise plan is billed in US dollars via Stripe, and every plan can also be paid in dollars. Handles and per-school theming keep each school's identity its own.",
  },
  {
    q: "How long does onboarding actually take?",
    a: "The request form takes about five minutes; we review within 1–2 working days. Your admins get secure set-password links by email, bulk student import creates accounts with login slips in minutes, and the in-app guide walks every role through their first week.",
  },
  {
    q: "Do you reward referrals?",
    a: "Yes — give a term, get a term. Share your school's referral code (Billing → Refer a school); when the school you referred makes its first paid subscription on any plan, both schools automatically get one school term (3 months) of platform usage free. There's no cap: every school you refer earns another free term, and every reward shows in your billing history.",
  },
];

function Faq() {
  return (
    <section className="border-b border-border/60 bg-card">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Before you ask</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            The questions every proprietor asks us.
          </h2>
        </div>
        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          {FAQS.map((f) => (
            <details key={f.q} className="group rounded-xl border border-border/70 bg-background p-5 shadow-card open:shadow-elevated">
              <summary className="cursor-pointer list-none text-base font-semibold tracking-tight marker:content-none">
                <span className="flex items-start justify-between gap-3">
                  {f.q}
                  <span aria-hidden className="mt-0.5 text-primary transition-transform group-open:rotate-45">+</span>
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Onboard() {
  return (
    <section id="onboard" className="relative scroll-mt-20 overflow-hidden border-b border-border/60 bg-primary text-primary-foreground">
      {/* sliding photographic background */}
      <div aria-hidden className="absolute inset-0">
        <HeroCarousel images={ONBOARD_IMAGES} intervalMs={6000} showDots={false} zoom={false} className="h-full w-full" />
      </div>
      {/* green brand overlay keeps the section on-brand while the photos show through */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-primary/95 via-primary/90 to-primary/70" />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12]" style={RULE_GRID} />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 lg:grid-cols-2">
        <div>
          <p className="eyebrow text-primary-foreground/70">Onboard your school</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
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
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us about your school — location, size, the modules you need and who to reach. Takes about
            five minutes; we review every request and get back to you within 1–2 working days.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {["School profile & location", "Student and staff numbers (drives your live price estimate)", "Plan tier and add-on modules", "Your contact details"].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <Link href="/onboard" className="mt-6 block">
            <Button size="lg" className="w-full">Start your onboarding request</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function ParentBand() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <img
        src="/images/band-community.jpg"
        alt=""
        aria-hidden
        width={2000}
        height={1333}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-neutral-950/85 via-neutral-950/70 to-neutral-950/40" />
      <div className="relative mx-auto flex max-w-6xl flex-col items-start justify-between gap-5 px-5 py-16 text-white sm:px-8 md:flex-row md:items-center">
        <div>
          <p className="eyebrow text-white/70">For parents</p>
          <h2 className="mt-2 font-display text-xl font-semibold tracking-tight sm:text-2xl">
            Looking for a school for your child?
          </h2>
          <p className="mt-1.5 max-w-md text-sm text-white/80">
            Browse onboarded schools and submit an application online — you&apos;ll be notified once it&apos;s reviewed.
          </p>
        </div>
        <div className="flex shrink-0 gap-3">
          <Link href="/schools"><Button variant="outline" className="border-white/40 bg-white/10 text-white hover:bg-white/20">Browse schools</Button></Link>
          <Link href="/apply"><Button className="bg-white text-neutral-900 hover:bg-white/90">Apply now</Button></Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const columns: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
    {
      title: "Product",
      links: [
        { label: "Modules", href: "#modules" },
        { label: "Security & privacy", href: "#security" },
        { label: "Plans & pricing", href: "#plans" },
        { label: "Referral programme", href: "#referral" },
        { label: "How onboarding works", href: "#onboard" },
      ],
    },
    {
      title: "For schools",
      links: [
        { label: "Request onboarding", href: "/onboard" },
        { label: "Sign in to your portal", href: "/login" },
        { label: "Reset your password", href: "/reset-password" },
      ],
    },
    {
      title: "For parents & careers",
      links: [
        { label: "Browse schools", href: "/schools" },
        { label: "Apply for admission", href: "/apply" },
        { label: "Work with a school", href: "/careers" },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy Policy", href: "/legal/privacy" },
        { label: "Service Agreement", href: "/legal/terms" },
        { label: "Data Processing Agreement", href: "/legal/dpa" },
        { label: "Refund Policy", href: "/legal/refunds" },
        { label: "Security & Cyber Addendum", href: "/legal/security" },
      ],
    },
  ];
  return (
    <footer className="relative overflow-hidden bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.5]" style={RULE_GRID} />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <img src="/images/platform-mark.png" alt="MajorGBN" width={128} height={128} className="h-9 w-9 object-contain" />
            <div className="leading-tight">
              <span className="block text-sm font-semibold tracking-tight">MAESTRO-SMS</span>
              <span className="block text-xs text-muted-foreground">School Management System</span>
            </div>
          </div>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            One secure register for your whole school — admissions to alumni, classes to fees, with
            student-data privacy and least-privilege access at its core.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {["NDPR-aligned", "Audit-logged", "Tenant-isolated"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <CheckIcon className="h-3 w-3 text-brand2" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="eyebrow">{col.title}</p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.href.startsWith("#") ? (
                    <a href={l.href} className="hover:text-foreground">{l.label}</a>
                  ) : (
                    <Link href={l.href} className="hover:text-foreground">{l.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="relative border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>
            © {new Date().getFullYear()} MAESTRO-SMS · Powered by{" "}
            <span className="font-semibold text-foreground/80">MajorGBN Innovations Limited</span> —
            willingness to serve, readiness to lead.
          </p>
          <p>Multi-tenant · NDPR-aligned · audit-logged · least-privilege by design.</p>
        </div>
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
      <ProductShowcase />
      <Audiences />
      <Testimonials />
      <PhotoMarquee />
      <RevenueBand />
      <Plans />
      <ReferralBand />
      <Steps />
      <Faq />
      <Onboard />
      <ParentBand />
      <Footer />
    </main>
  );
}
