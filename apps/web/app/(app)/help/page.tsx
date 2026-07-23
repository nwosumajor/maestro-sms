import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// The application manual. ROLE-AWARE: each section is shown only to users whose
// permissions (and where flows are relationship-scoped, ROLES) make it relevant,
// so a parent never reads payroll instructions and a teacher isn't buried in
// operator material. Linked from the welcome email and the nav.
//
// ACCURACY RULE: every step names a real page in the left nav and describes the
// flow as ENFORCED by the API (maker-checker, approval chains, consent gates) —
// when a feature changes, update the matching guide in the same PR.

type Step = { title: string; body: string };

function Guide({ title, description, steps }: { title: string; description: string; steps: Step[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3 text-sm">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <span>
                <span className="font-medium">{s.title}</span>
                <span className="block text-muted-foreground">{s.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default async function HelpPage() {
  const session = await auth();
  const user = session!.user;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(user.permissions, p);
  const roles = user.roles ?? [];
  const is = (r: string) => roles.includes(r);
  // Module availability (nav-parity): null modules = older session, don't gate.
  const mod = (m: string) => !user.modules || user.modules.includes(m);

  const isStudent = is("student");
  const isParent = is("parent");
  const isTeacher = is("teacher") || is("head_teacher");
  const isLeadership = is("principal") || is("school_admin");
  const isStaffAdmin = can("rbac.manage") || (can("fee.manage") && isLeadership);
  const isPlatform = can("platform.tenants.read"); // owner OR delegated manager_admin

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="help" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Help &amp; user guide</>} subtitle={<>The application manual, tailored to your role. Every action below lives in the left navigation.</>} />

        {/* Leadership-only: the long-form School Leader's Manual. Served from
            /manual behind the session gate — it documents real lockout and
            approval policy, so it is deliberately not public. */}
        {isLeadership && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">The School Leader&apos;s Manual</CardTitle>
              <CardDescription>
                The complete owner and principal handbook — your first 30 days, delegating roles, the
                approval rules behind every control, fees and subscription, and a term-by-term operating
                rhythm. Written to be read once and then kept for reference.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href="/manual"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Open the manual
              </a>
              <p className="mt-3 text-xs text-muted-foreground">
                Opens in a new tab. Printable — most principals keep a copy on the desk for the first term.
              </p>
            </CardContent>
          </Card>
        )}

        <Guide
          title="The basics (everyone)"
          description="How the portal works, whatever your role."
          steps={[
            { title: "Navigation", body: "The left menu shows only what your role can use. Your school's enabled modules decide which sections exist — if something's missing, your school's plan doesn't include it yet." },
            { title: "Notifications", body: "The Notifications page is your in-app inbox — payment receipts, absences, approvals, scholarship updates and announcements land there (and by email where configured)." },
            { title: "Your account", body: "On the Account page: change your password, enrol two-factor authentication (recommended for all staff), and add your phone number so the school can reach you by SMS or WhatsApp where enabled. Forgot your password? Use the link on the sign-in page — a one-time reset link is emailed to you." },
            { title: "Security", body: "Sensitive actions ask you to re-confirm your password (step-up). Staff passwords expire every 30 days; three failed sign-ins lock the account until an administrator reactivates it. Never share your login." },
            { title: "Messages & calendar", body: "Messages is two-way: write to staff and read replies in one thread. Calendar shows school events for your audience." },
          ]}
        />

        {isStudent && (
          <Guide
            title="Students — your school day"
            description="Learning, results and everything you can do yourself."
            steps={[
              { title: "Learn in your classes", body: "Classes → your class → Content: lessons, materials, quizzes and forums your teachers publish. Quiz scores can count toward your continuous assessment." },
              { title: "Assessments & fair play", body: "Assessments lists your assignments and tests. Integrity monitoring only ever raises signals for a TEACHER to judge — nothing automatic ever punishes you. If you use assistive technology, ask your teacher for an exemption." },
              { title: "Check your results", body: "Grades shows published scores and term results; pick your elective subjects there when your school opens subject selection (your choice goes to a teacher for approval). Report cards appear under Documents." },
              { title: "Sit CBT exams", body: mod("cbt") ? "CBT exams lists computer-based tests published for you. The clock is server-controlled — answers save as you go and the sitting submits automatically when time ends. Scholarship qualification exams appear here too." : "When your school enables the CBT module, computer-based tests appear under CBT exams with a server-controlled clock." },
              { title: "Apply for a scholarship", body: "Scholarships: when a platform scholarship is open, request it yourself with the detailed form (your reason is required; your grades, attendance and record attach automatically). It then goes to your class supervisor → your parent/guardian → the principal → the sponsor. You're notified at every stage; if you qualify, the exam date and how to sit it arrive in Notifications, and the best three candidates win." },
              { title: "Fees & documents", body: "Fees shows your invoices and payments; Documents holds your report cards, receipts and certificates as secure downloads." },
              { title: "Find your exam hall and seat", body: "Exams lists every exam scheduled for you with the hall, the time and your seat number — check it the day before so you walk straight to the right place." },
              { title: "Borrow from the library", body: mod("library") ? "Library: search the catalogue and see your loans and any fines. Return on time — fines are recorded against your account." : "When your school enables the Library module, your loans appear under Library." },
              { title: "Take part", body: "Tasks (work assigned to you), Polls (anonymous votes), Discussion (moderated topic groups) and Forms (school surveys) are yours to join. Discipline lets you file a complaint with evidence — a person always reviews it." },
            ]}
          />
        )}

        {isParent && (
          <Guide
            title="Parents & guardians — following your child"
            description="Everything about your children in one place, plus the approvals only you can give."
            steps={[
              { title: "Your children at a glance", body: "My children lists each linked child; open one for their profile, classes, attendance and results as teachers publish them. Analytics shows the same, summarised per child." },
              { title: "Pay fees online", body: "Fees: open an invoice and pay the outstanding balance by card from your phone — or by ordinary bank transfer to your child's dedicated account number (shown on the invoice page once the school assigns it; transfers credit the oldest unpaid invoice automatically). The receipt (with the new balance) lands in Notifications and by email, and every posted payment has a downloadable receipt PDF. If the school sets a payment plan, the invoice page shows each part and its due date. Overpayments are flagged to the school's finance staff for refund." },
              { title: "Prepay when it suits you", body: "The invoice page shows your child's credit balance — top it up online any time and the school applies it to invoices as they come due. Useful for paying ahead of term." },
              { title: "Approve scholarship requests", body: "Scholarships: when your child requests a scholarship (or their teacher applies for them), it reaches YOU after the class supervisor. Your approval is also your consent to share their academic record with the sponsor — nothing is submitted without it. You can also start an application for your child yourself. You're notified at every later stage, through to the award." },
              { title: "Absence alerts", body: "You're notified automatically the moment your child is marked absent or late on the register." },
              { title: "Book a meeting with a teacher", body: "Meetings shows the appointment slots teachers have opened. Pick one, choose which child it's about, and book — the teacher is notified straight away. You can cancel from the same page (so can they, and you'll be told)." },
              { title: "Your child's exam hall and seat", body: "Exams shows each child's upcoming exams with hall, time and seat number." },
              { title: "Choose how we contact you", body: "Account → Notification preferences: switch email, SMS or WhatsApp on or off, and mute categories you don't need (announcements, fee reminders, grade publications…). Your in-app inbox always keeps everything, and payment and security notices are always sent." },
              { title: "Cross-school games consent", body: "If the school invites your child to a cross-school games event, it requires your explicit consent first — only a pseudonymous handle (never their name) is visible to other schools." },
              { title: "Message the school", body: "Messages: write to your child's teachers or the school office; replies appear in the same thread and in Notifications." },
              { title: "Applying for another child?", body: "The public Browse Schools directory lets you apply to any onboarded school online; you're notified when the school reviews it." },
            ]}
          />
        )}

        {isTeacher && (
          <Guide
            title="Teachers — daily work"
            description="The core teaching loop, plus the decisions only you can make."
            steps={[
              { title: "Take the register", body: "Attendance → Take register for your class each morning. Guardians of absent or late students are notified automatically." },
              { title: "Teach with the LMS", body: "Classes → Content: publish lessons (structured blocks), materials, quizzes and forums. Tag quizzes and assignments with a subject and term and their scores can flow into report-card continuous assessment. Content revisions are kept — you can revert or clone." },
              { title: "Grade work", body: "Grades: record scores per subject and term. Publishing grades goes through an approval, and report cards are generated from published grades plus attendance." },
              { title: "Review integrity signals", body: "Assessments: cheating-detection raises signals (paste bursts, focus loss, similarity) for YOUR judgement — the system never punishes a student automatically. Grant exemptions for students using assistive technology." },
              { title: "Author CBT exams", body: mod("cbt") ? "CBT exams: build question banks, then schedule timed exams that sample questions per sitting. Auto-marked scores are numbers for YOUR review — you decide what they mean." : "When your school enables the CBT module you can author question banks and timed exams under CBT exams." },
              { title: "Decide scholarship requests", body: "Scholarships: requests from students in the class you supervise wait under “Awaiting your decision” — you are the FIRST stage of the approval chain (then guardian, then principal). You can also apply on behalf of any student you teach. Approve or reject with a note; everyone involved is notified." },
              { title: "Run class games", body: "Games: host a Live Quiz, Hangman or Typing Race for your class, or open a Class Race. Games only ever produce points and practice — never a grade or a record." },
              { title: "Write report-card remarks", body: "Open a student you teach → Report card & remarks: pick the term and write the class teacher's remark. It prints on the report card under Remarks. The head's remark is written by the principal or a school administrator." },
              { title: "Offer parent meeting slots", body: "Meetings: open time slots and parents book them for a chat about their child. You're notified on every booking and cancellation; withdraw a slot any time before it's booked." },
              { title: "Cover and invigilation duties", body: "If you're asked to cover a colleague's lesson while they're on leave, or to invigilate an exam, you're notified and it appears under Timetable and Exams respectively." },
              { title: "Your own HR", body: "Leave: apply for leave (it routes head → HR manager → principal and your balance updates on approval), see who's out, keep your personal and bank details current, and download your payslips." },
            ]}
          />
        )}

        {isStaffAdmin && (
          <Guide
            title="Getting started — school administrators"
            description="The recommended first-week setup order for a newly onboarded school."
            steps={[
              { title: "Create your staff", body: "Admin → Users: add teachers, accountants and other staff. Each gets a one-time temporary password and must reset it at first login. Assign or change roles under Admin → Roles." },
              { title: "Import your students", body: "Admin → Bulk import: upload a CSV of students (idempotent on email). Approval generates login slips with one-time passwords per student, and parent links can be imported too." },
              { title: "Build classes & subjects", body: "Classes: create classes, assign teachers, set the class supervisor (form teacher), enrol students and link guardians. Set up the academic session and terms so grading has the right periods." },
              { title: "Set up the timetable", body: "Timetable: define periods and rooms, then place lessons — double-bookings are rejected automatically." },
              { title: "Configure fees", body: "Fees: build your fee catalog and issue invoices. Parents pay online by card; money settles to the bank account you register; large manual postings and all refunds need a second approver." },
              { title: "Review admissions", body: "Admin → Admissions: public applications arrive quarantined from student data until you review them. If you charge an admission-form fee, paid/unpaid status shows on each application." },
              { title: "Brand your portal", body: "Admin → Branding: upload your school logo (square, 128–2048px) and pick your brand colour and font — it appears for every member and on generated documents." },
              { title: "Cover for absent teachers", body: "Timetable → Teacher cover: pick a date range and the system lists every lesson whose teacher is on approved leave, so nothing is left unattended. Assign a reliever — it refuses anyone already teaching that period and notifies whoever you pick." },
              { title: "Run exams", body: "Exams: schedule a sitting (hall, date, time, seats), seat a whole class in one click, and roster invigilators. Students and parents then see their own hall, time and seat number; invigilators see their duties." },
              { title: "Require 2FA for staff", body: "Admin → Roles → Require two-factor authentication for staff: when on, every staff member must set up an authenticator app before they can use the app. Students and parents are unaffected." },
              { title: "Find anything fast", body: "The search box in the header jumps straight to a student, staff member, class or invoice — no need to navigate the module first." },
              { title: "Mind the guardrails", body: "Admin → Audit is the searchable log of every sensitive action; Admin → Security handles just-in-time privilege elevation (approved by a DIFFERENT person); Admin → Recertification reviews who still needs their access; Admin → Privacy handles NDPR data-export and erasure requests." },
              { title: "Check your subscription", body: "Billing: your plan, per-student pricing (monthly / per-term −5% / per-year −15%), payment history and renewal — paying activates instantly." },
              { title: "Delegate with junior admins", body: "Appoint a junior admin for day-to-day work (records, attendance, timetable, fee RECORDING, admissions review) while approvals stay senior-only. Appointing one — or adding roles to one — raises an approval that a DIFFERENT senior (the other admin or the principal) must confirm under Approvals." },
            ]}
          />
        )}

        {can("admission.review") && !can("rbac.manage") && (
          <Guide
            title="Junior administrators — day-to-day operations"
            description="The operational tier: you run the desk; approvals stay with your seniors."
            steps={[
              { title: "Records & registers", body: "Students, classes, enrolment, guardians, attendance, timetable and documents are yours to keep current. Every change is audit-logged under your name." },
              { title: "Record fees, don't approve them", body: "Fees: you can issue invoices and record payments. Large payments and ALL refunds wait for a senior with approval rights — that separation protects you as much as the school." },
              { title: "Review admissions", body: "Admin → Admissions: triage public applications and their form-fee status." },
              { title: "Need more for a task?", body: "Request just-in-time elevation under Security — a senior approves a time-boxed grant. Your own role changes also require senior approval, so ask your school admin or principal." },
            ]}
          />
        )}

        {(can("workflow.review.head") || can("workflow.review.hr") || can("workflow.review.principal")) && (
          <Guide
            title="Approvers — your stage in the chain"
            description="For heads, HR managers and principals who approve staff requests."
            steps={[
              { title: "Check Approvals regularly", body: "Approvals → your queue shows requests waiting at YOUR stage (leave, staff requests, purchase orders, fee-schedule runs). The staff chain is head → HR manager → principal." },
              { title: "One person, one stage", body: "You cannot act twice on the same request, and you cannot approve something you initiated — the engine enforces separation of duties." },
              { title: "Approve or reject with a note", body: "Your decision advances the request to the next stage (or ends it). The requester is notified automatically at the end." },
              { title: "Sign off report cards", body: "Open a student → Report card & remarks: the head's remark is yours to write (the class teacher writes theirs). Both print on the generated card." },
              ...(can("workflow.review.principal")
                ? [{ title: "Principal: scholarship requests too", body: "Scholarships → “Awaiting your decision”: you are the FINAL school stage for a student's scholarship request (after the class supervisor and the guardian). Your approval forwards it to the platform sponsor." }]
                : []),
            ]}
          />
        )}

        {(can("fee.approve") || (can("fee.manage") && !can("rbac.manage"))) && (
          <Guide
            title="Finance — fees, approvals & settlement"
            description="Collecting, controlling and reconciling school money."
            steps={[
              { title: "Issue and track invoices", body: "Fees: build fee items, raise invoices, and follow DRAFT → ISSUED → PARTIALLY PAID → PAID. Parents can pay any invoice online by card (USD invoices route through the international card gateway automatically)." },
              { title: "Understand maker-checker", body: "Payments of ₦50,000+ and ALL refunds post as pending until a DIFFERENT staff member with approval rights confirms them — you cannot approve your own entry. Discounts and waivers work the same way: request one on the invoice page and a different approver confirms it before the total changes. This protects you as much as the school." },
              { title: "Receipts send themselves", body: "Every posted payment — cash you record or a card payment online, partial or full — automatically receipts the payer, the guardians and the student, with the new balance. A numbered receipt PDF can be downloaded from any posted payment row. Overpayments are flagged to you as refund-due — or move the excess to the student's credit balance in one click; approved card refunds are pushed back to the original card." },
              { title: "Collect by bank transfer", body: "On any invoice, create the student's dedicated account number once — transfers to it credit their oldest unpaid invoice automatically, no hand-recording. A transfer with no open invoice lands on the student's credit balance and you're told." },
              { title: "Payment plans & credit", body: "Split any issued invoice into scheduled parts (the parts must add up to the total; each shows PAID / DUE / OVERDUE as money arrives). The student's credit balance — prepayments and moved overpayments — can be applied to any open invoice from its page." },
              { title: "Late fees run themselves", body: "Fees → Reports → Automatic late fee: set a flat fee and grace period once; invoices still unpaid past due + grace get the fee added exactly once, guardians notified. Overdue payment reminders also go out weekly on their own — the manual reminder button remains for ad-hoc pushes." },
              { title: "Set up direct settlement", body: "Fees → Reports → Fee settlement account: register the school's bank once and every online payment splits straight to it — the platform never holds your fees. You also choose who bears the card-processing charge (parent or school), and can set an admission-form fee for public applicants." },
              { title: "If a payment is disputed", body: "Fees → Reports → Disputes: chargebacks raised at the card gateway appear with their evidence deadline the moment they open. Record your response in-system and submit evidence on the gateway dashboard — an unanswered dispute is lost by default. A lost dispute tells you to record the matching refund so the books follow the money." },
              { title: "Read the reports, export the journal", body: "Fees → Reports: receivables aging and collection summaries. Journal export downloads every posted payment (signed amounts, receipt numbers) as CSV for your accounting software. Scholarship awards arrive as credits on the student's invoice, clearly marked." },
            ]}
          />
        )}

        {can("hr.read") && (
          <Guide
            title="HR — staff records, leave & payroll"
            description="The staff lifecycle from recruitment to exit."
            steps={[
              { title: "Keep the register complete", body: "HR: every staff account should have an employment record — the page flags accounts still missing one. Salaries are encrypted; every view of them is logged." },
              { title: "Recruit through the pipeline", body: "HR → Recruitment: open requisitions, track applicants (the public careers page feeds them in, CVs attached), and convert a hire into a staff account + employment record in one step." },
              { title: "Leave flows through approvals", body: "Staff apply on the Leave page; requests route head → HR manager → principal. Balances (including half-days) update automatically on final approval, and the leave calendar shows who's out." },
              { title: "Salary changes are maker-checker", body: "One person requests, a different person approves — both with password re-confirmation. The request history IS the salary history. Allowances, deductions and staff loans follow the same discipline." },
              { title: "Run payroll", body: "HR → Payroll: a run snapshots active salaries with Nigerian PAYE, pension and loan recoveries computed; a second person finalises. Payslips, bank-export and remittance CSVs come from the run; 13th-month/bonus runs are supported." },
              { title: "Exits are settled, not deleted", body: "Offboarding computes the final settlement (pro-rata pay + unused leave − outstanding loans) under maker-checker, auto-opens the offboarding checklist, and the record is retained as statutory history." },
            ]}
          />
        )}

        {(can("hostel.manage") || can("transport.manage") || can("library.manage")) && (
          <Guide
            title="Facilities — hostel, transport & library"
            description="For wardens, drivers/fleet heads and librarians."
            steps={[
              { title: "Hostel (wardens)", body: "Hostel: rooms, bed availability and student allocation for your house — head wardens see every hostel. Hostel fee runs route through an approval before they bill." },
              { title: "Transport (drivers & fleet)", body: "Transport: your vehicle, route and passenger list — the head driver manages the whole fleet. Route changes automatically alert affected parents, and transport fee runs also need an approval." },
              { title: "Library (librarians)", body: "Library: the barcode catalogue, loans and fines. A copy must be available to issue; books with loan history can't be deleted." },
            ]}
          />
        )}

        {can("workflow.veto") && (
          <Guide
            title="Board — oversight"
            description="Read-only visibility with one deliberate power."
            steps={[
              { title: "See without touching", body: "You can read classes, grades, workflows, fees, scholarships and documents across the school — but not modify them." },
              { title: "The veto", body: "On any approval workflow you may exercise a veto — the one active power the board holds, and it is audit-logged like everything else." },
            ]}
          />
        )}

        {can("game.leaderboard.read") && (
          <Guide
            title="Games — learning through play"
            description="Curriculum-themed games for engagement and friendly competition. They only ever produce points and practice — never a grade or a penalty."
            steps={[
              { title: "Find the games", body: "Games in the left menu lists every game. Each has its own screen with a live leaderboard that updates as you play." },
              { title: "Number-guessing (Dead & Wounded)", body: "Quick Duel is a head-to-head code-breaking match; the Elimination Ring knocks players out one by one (crack your target's code to eliminate them and inherit their progress); a Class Race has everyone racing to crack one shared code — first three home win. Teachers open races; principals and admins can run whole Leagues and Knockouts." },
              {
                title: "Live Quiz, Hangman & Typing Race",
                body: can("game.quiz.host")
                  ? "Host a themed multiple-choice quiz, a Hangman round or a Typing Race for your class — difficulty sets the challenge, and students score for speed and accuracy. Starter quizzes are ready to host; you can author, edit and delete your own."
                  : "Join the quiz, Hangman round or Typing Race your teacher opens — answer before the timer, guess the word before the lives run out, or type the passage fastest and most accurately.",
              },
              { title: "Checkers & Chess", body: "Challenge a classmate directly: create a game and share it (or join an open one), then take turns. Each game carries a chess clock — pick the time control (Classical, Rapid or Blitz) when you start. If your opponent's clock runs out, you can claim the win." },
              { title: "Ultimate — cross-school", body: "The one arena that crosses schools. Entering needs your school enrolled AND (for students) explicit guardian consent; you compete under a pseudonymous handle — your real name never leaves your school. Scholarship exams held “in the games arena” run here too." },
              { title: "Fair play by design", body: "Every move, guess and answer is validated by the server, so the games are cheat-resistant — and nothing a game does ever affects a mark, a grade or a record." },
            ]}
          />
        )}

        {can("billing.read") && !isPlatform && (
          <Guide
            title="Billing & subscription"
            description="How your school pays for the platform — and earns from it."
            steps={[
              { title: "Per-seat pricing", body: "You pay per active student per month. Choose monthly, per-term (3 months, 5% off) or per-year (9 months, 15% off) billing. Adding students mid-period accrues a small seat top-up you can settle any time — it's added to your next renewal otherwise." },
              { title: "Currencies & auto-renew", body: "Pay in naira (Paystack) or US dollars (Stripe); the Enterprise plan is billed in dollars only. After a card payment you can switch on auto-renew — the saved card is charged just before your period lapses." },
              { title: "Renewal & grace", body: "You'll see a renewal banner from 14 days out. If a payment lapses, you keep full access for a grace window (7 days by default); after that the school runs on the Standard core until payment — nothing is ever deleted, and paying restores your plan instantly." },
              { title: "Refer a school, earn a term", body: "Billing → Refer a school: share your referral code or link. When the school you referred makes its first paid subscription, BOTH schools automatically get one term (3 months) free — no cap, and every reward shows in your billing history." },
              { title: "Message credits", body: "To reach parents by SMS or WhatsApp (not just in-app/email), buy a message-credit bundle on the Billing page — each SMS/WhatsApp delivery uses one credit, and credits never expire while you're subscribed." },
            ]}
          />
        )}

        {can("billing.read") && mod("group") && !isPlatform && !isStudent && !isParent && (
          <Guide
            title="Group console — multi-school proprietors"
            description="For directors appointed over a group of campuses."
            steps={[
              { title: "One dashboard, every campus", body: "Group shows cross-campus aggregates — enrolment, attendance, collection — never individual student records. Directorship is granted by the platform operator." },
            ]}
          />
        )}

        {isPlatform && (
          <Guide
            title="Platform operations"
            description="Running the platform (owner and platform staff)."
            steps={[
              { title: "Know the consoles", body: "Operator is the hub: provisioning, onboarding review and platform settings. Tenant registry is the per-school management list (subscription, status, grace, accounts, exports). School directory is the read-only register of every school — owners, contacts, billing at a glance; click through for a full profile. Platform audit is the cross-tenant action log." },
              { title: "Onboard schools", body: "Operator: review public onboarding requests, then Approve & provision — the form pre-fills from the request and the founding admins receive set-password invite links by email (passwords never travel)." },
              { title: "Watch the red banner", body: "Lapsed schools appear in the red billing banner and the daily alert digest. Open the school in the Tenant registry to extend, comp or restore — paying restores the plan automatically." },
              { title: "Money-safety alerts find you", body: "Chargeback disputes on platform revenue alert you the moment they open; a school hitting 3 disputes in 30 days escalates (gateway-suspension risk). The nightly reconciliation sweep re-checks the gateway's settled charges against the ledger — if it ever recovers a missed payment you're told, because that means webhook delivery is unhealthy. A manual sweep is one call away." },
              { title: "Support without power-grabs", body: "You can look up a school's user accounts and clear login lockouts for support. Credential resets, impersonation and student-data exports are owner-only, step-up gated and fully audited." },
              { title: "Rehearse the restore", body: "Backups are automatic (14-day point-in-time recovery plus weekly/monthly archives), but an untested backup is not a backup — run the restore drill on the documented cadence. It restores into a throwaway database and proves the data comes back WITH row-level security and tenant isolation intact. See docs/RUNBOOK-BACKUP-RESTORE.md." },
              { title: "The dashboard is your analytics", body: "Dashboard: cross-tenant business metrics (schools, MRR, growth, onboarding funnel) plus fleet-wide games adoption — aggregate counts only, never player identities." },
            ]}
          />
        )}

        {can("scholarship.admin") && (
          <Guide
            title="Scholarship administration (platform owner)"
            description="Running platform-sponsored scholarships end to end."
            steps={[
              { title: "Create & fund programmes", body: "Scholarship admin: create a programme with a category (General Science, Art, Community Development, Mathematics or Special), an application window, and 1st/2nd/3rd prize amounts. Open it and every school sees it." },
              { title: "Applications arrive fully approved", body: "A student's request only reaches your queue after their class supervisor, guardian (whose approval is the consent) and principal have each approved. The application carries verified signals — grades, attendance, fees, discipline, tasks — for your judgement, never a verdict." },
              { title: "Qualify candidates for the exam", body: "Mark the candidates you accept as QUALIFIED — they and their guardians are notified that an exam is coming." },
              { title: "Schedule & announce the exam", body: "Set the exam mode — online CBT (author the questions inline; a timed exam is published per school for qualified candidates only), the games arena (a cross-school event is opened for them), or a physical exam — plus the date and venue, then Announce: every candidate and guardian is notified with how to sit it." },
              { title: "Collect results & award the best three", body: "After the exam, Collect results pulls each candidate's score onto their application and ranks the queue. Award 1st, 2nd and 3rd (each position once; three awards max) — the prize is credited straight against the student's school-fee invoice and the family is congratulated automatically." },
            ]}
          />
        )}

        {can("platform.pricing.manage") && (
          <Guide
            title="Platform revenue (owner-only)"
            description="Pricing, fees and growth levers."
            steps={[
              { title: "Set plan pricing", body: "Operator → Plan pricing: per-tier per-seat prices in naira and dollars. What you save here is exactly what checkout charges and the public homepage shows — marketing can never drift from the bill." },
              { title: "Fee-collection take-rate", body: "Operator → Platform fees: the convenience fee on schools' online fee collection (flat + percentage + cap). Each school chooses whether the parent or the school bears it; it's always shown to the payer before they pay." },
              { title: "Promos & agents", body: "Operator → Growth: percent-off promo codes for a school's first charge, and agent (reseller) codes that accrue a commission when an attributed school first pays." },
              { title: "Hire platform staff", body: "Operator → Platform staff: appoint manager_admins to run delegable duties (onboarding, registry, support). Owner powers — impersonation, credentials, pricing, student data — can never be delegated or self-granted." },
            ]}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Need more help?</CardTitle>
            <CardDescription>
              Ask your school administrator first — they control accounts, roles and modules for your school.
              School administrators can reach the platform team through their onboarding contact.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </AppShell>
  );
}
