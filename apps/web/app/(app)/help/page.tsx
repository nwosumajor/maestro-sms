import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// The application manual. ROLE-AWARE: each section is shown only to users whose
// permissions make it relevant, so a parent never reads payroll instructions and
// a teacher isn't buried in operator material. Linked from the welcome email
// ("the in-app Help page has the getting-started guide") and the nav.

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
  const isStaffAdmin = can("rbac.manage") || can("fee.manage");
  const isTeacher = can("grade.write") || can("attendance.write");
  const isParentOrStudent = !isStaffAdmin && !isTeacher && (can("fee.read") || can("document.read"));
  const canHostGames = can("game.quiz.host");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="help" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Help &amp; user guide</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The application manual, tailored to your role. Every action below lives in the left navigation.
          </p>
        </div>

        <Guide
          title="The basics (everyone)"
          description="How the portal works, whatever your role."
          steps={[
            { title: "Navigation", body: "The left menu shows only what your role can use. Your school's enabled modules decide which sections exist." },
            { title: "Notifications", body: "The Notifications page is your in-app inbox — payment receipts, absences, approvals and announcements land there (and by email where configured)." },
            { title: "Your account", body: "Change your password and enrol two-factor authentication (recommended for all staff) on the Account page. Forgot your password? Use the link on the sign-in page — a one-time reset link is emailed to you." },
            { title: "Security", body: "Sensitive actions ask you to re-confirm your password. Passwords expire every 30 days for staff; never share your login." },
          ]}
        />

        {isStaffAdmin && (
          <Guide
            title="Getting started — school administrators"
            description="The recommended first-week setup order for a newly onboarded school."
            steps={[
              { title: "Create your staff", body: "Admin → Create profiles: add teachers, accountants and other staff. Each gets a one-time temporary password and must reset it at first login." },
              { title: "Import your students", body: "Admin → Bulk import: upload a CSV of students (idempotent on email). Approval generates login slips with one-time passwords per student." },
              { title: "Build classes & subjects", body: "Classes: create classes, assign teachers, set the class supervisor (form teacher), enrol students and link guardians." },
              { title: "Set up the timetable", body: "Timetable: define periods and rooms, then place lessons — double-bookings are rejected automatically." },
              { title: "Configure fees", body: "Fees: build your fee catalog and issue invoices. Parents can pay online by card; large manual postings need a second approver." },
              { title: "Check your subscription", body: "Billing: your plan, per-student pricing (monthly / per-term −5% / per-year −15%), payment history and renewal — paying activates instantly." },
              { title: "Brand your portal", body: "Admin → Branding: upload your school logo (square, 128–2048px) and pick your brand colour — it appears for every member and on documents." },
            ]}
          />
        )}

        {isTeacher && (
          <Guide
            title="Daily work — teachers"
            description="The core teaching loop."
            steps={[
              { title: "Take the register", body: "Attendance → Take register for your class each morning. Guardians of absent or late students are notified automatically." },
              { title: "Teach with the LMS", body: "Classes → Content: publish lessons, materials and quizzes to your classes. Quiz results can flow into report-card continuous assessment." },
              { title: "Grade work", body: "Gradebook: record scores per subject and term. Report cards are generated from published grades plus attendance." },
              { title: "Review integrity signals", body: "Assessments: cheating-detection raises signals for YOUR judgement — the system never punishes a student automatically." },
              { title: "Request leave", body: "Leave: apply for leave; it routes through the approval chain and your balance updates on approval." },
            ]}
          />
        )}

        {isParentOrStudent && (
          <Guide
            title="For parents & students"
            description="Following progress and staying on top of school life."
            steps={[
              { title: "Check attendance & grades", body: "Attendance and Gradebook show your (or your child's) record as teachers publish it." },
              { title: "Pay fees online", body: "Fees: open an invoice and pay the outstanding balance by card — the receipt lands in Notifications and Documents." },
              { title: "Download documents", body: "Documents: report cards, receipts and certificates are issued here as secure downloads." },
              { title: "Message the school", body: "Messages: write to your teachers or the school office; replies appear here and in Notifications." },
            ]}
          />
        )}

        {can("game.leaderboard.read") && (
          <Guide
            title="Games — learning through play"
            description="Curriculum-themed games for engagement and friendly competition. They only ever produce points and practice — never a grade or a penalty."
            steps={[
              { title: "Find the games", body: "Games in the left menu lists every game. Each has its own screen with a live leaderboard that updates as you play." },
              {
                title: "Live Quiz",
                body: canHostGames
                  ? "Author a themed multiple-choice quiz (Geography, Science, Art, Literature) at an EASY/MEDIUM/HARD difficulty, then host a session for one of your classes — students join and answer against a timer, scoring more for faster correct answers. Four starter quizzes are ready to host, and you can edit or delete your own."
                  : "When your teacher hosts a quiz for your class, join it and answer each question before the timer runs out — the quicker and more accurate you are, the higher you score.",
              },
              {
                title: "Hangman & Typing Race",
                body: canHostGames
                  ? "Host a Hangman round (students guess the word before the lives run out) or a Typing Race (type the shared passage fastest and most accurately) for a class; difficulty sets the challenge. You can supply your own word or passage, or let the game pick one."
                  : "Join a Hangman round or Typing Race your teacher opens — guess letters to reveal the word, or type the passage as fast and accurately as you can. Speed and accuracy both count.",
              },
              {
                title: "Checkers & Chess",
                body: "Challenge a classmate directly: create a game and share it (or join an open one), then take turns. Each game carries a chess clock — pick the time control (Classical, Rapid or Blitz) when you start. If your opponent's clock runs out, you can claim the win.",
              },
              {
                title: "Fair play by design",
                body: "Every move, guess and answer is validated by the server, so the games are cheat-resistant — and nothing a game does ever affects a mark, a grade or a record.",
              },
            ]}
          />
        )}

        {(can("fee.approve") || (can("fee.manage") && !can("rbac.manage"))) && (
          <Guide
            title="Finance — fees, approvals & settlement"
            description="Collecting, controlling and reconciling school money."
            steps={[
              { title: "Issue and track invoices", body: "Fees: build fee items, raise invoices, and follow DRAFT → ISSUED → PARTIALLY PAID → PAID. Parents can pay any invoice online by card." },
              { title: "Understand maker-checker", body: "Payments of ₦50,000+ and ALL refunds post as pending until a DIFFERENT staff member with approval rights confirms them — you cannot approve your own entry. This protects you as much as the school." },
              { title: "Receipts send themselves", body: "Every posted payment — cash you record or a card payment online, partial or full — automatically receipts the payer, the guardians and the student by email and in-app, with the new balance." },
              { title: "Set up direct settlement", body: "Fees → Reports → Fee settlement account: register the school's bank once and every online payment settles straight to it." },
              { title: "Read the reports", body: "Fees → Reports: receivables aging and collection summaries; send bulk payment reminders to guardians from the same page." },
            ]}
          />
        )}

        {can("hr.read") && (
          <Guide
            title="HR — staff records, leave & payroll"
            description="The staff lifecycle from employment record to exit."
            steps={[
              { title: "Keep the register complete", body: "HR: every staff account should have an employment record — the page flags accounts still missing one. Salaries are encrypted; every view of them is logged." },
              { title: "Leave flows through approvals", body: "Staff apply on the Leave page; requests route head → HR manager → principal. Balances update automatically on final approval." },
              { title: "Salary changes are maker-checker", body: "One person requests, a different person approves — both with password re-confirmation. The request history IS the salary history." },
              { title: "Run payroll", body: "HR → Payroll: a run snapshots active salaries with Nigerian PAYE and pension computed; a second person finalises. Payslips and bank-export CSVs come from the run." },
              { title: "Exits are settled, not deleted", body: "Offboarding computes the final settlement (pro-rata pay + unused leave − outstanding loans) under maker-checker, and the record is retained as statutory history." },
            ]}
          />
        )}

        {(can("workflow.review.head") || can("workflow.review.hr")) && (
          <Guide
            title="Approvers — your stage in the chain"
            description="For heads and HR managers who approve staff requests."
            steps={[
              { title: "Check Approvals regularly", body: "Workflows → your queue shows requests waiting at YOUR stage (leave, staff requests). The chain is head → HR manager → principal." },
              { title: "One person, one stage", body: "You cannot act twice on the same request, and you cannot approve something you initiated — the engine enforces separation of duties." },
              { title: "Approve or reject with a note", body: "Your decision advances the request to the next stage (or ends it). The requester is notified automatically at the end." },
            ]}
          />
        )}

        {(can("hostel.manage") || can("transport.manage") || can("library.manage")) && (
          <Guide
            title="Facilities — hostel, transport & library"
            description="For wardens, drivers/fleet heads and librarians."
            steps={[
              { title: "Hostel (wardens)", body: "Hostel: rooms, bed availability and student allocation for your house — head wardens see every hostel. Hostel fee runs route through an approval before they bill." },
              { title: "Transport (drivers & fleet)", body: "Transport: your vehicle, route and passenger list — the head driver manages the whole fleet. Route changes automatically alert affected parents." },
              { title: "Library (librarians)", body: "Library: the barcode catalogue, loans and fines. A copy must be available to issue; books with loan history can't be deleted." },
            ]}
          />
        )}

        {can("workflow.veto") && (
          <Guide
            title="Board — oversight"
            description="Read-only visibility with one deliberate power."
            steps={[
              { title: "See without touching", body: "You can read classes, grades, workflows, fees and documents across the school — but not modify them." },
              { title: "The veto", body: "On any approval workflow you may exercise a veto — the one active power the board holds, and it is audit-logged like everything else." },
            ]}
          />
        )}

        {can("billing.read") && (
          <Guide
            title="Billing & subscription"
            description="How your school pays for the platform."
            steps={[
              { title: "Per-seat pricing", body: "You pay per active student per month. Choose monthly, per-term (3 months, 5% off) or per-year (9 months, 15% off) billing." },
              { title: "Currencies", body: "Pay in naira (Paystack) or US dollars (Stripe). The Enterprise plan is billed in dollars only." },
              { title: "Renewal & grace", body: "You'll be reminded 14 days before renewal. If a payment lapses, you keep full access for a 7-day grace window; after that the school runs on the Standard core until payment — nothing is ever deleted, and paying restores your plan instantly." },
            ]}
          />
        )}

        {can("platform.operate") && (
          <Guide
            title="Platform operations (super admin)"
            description="Running the platform itself."
            steps={[
              { title: "Onboard schools", body: "Operator: review public onboarding requests, then Approve & provision — the form pre-fills and the founding admins receive set-password invite links by email." },
              { title: "Set pricing", body: "Operator → Plan pricing: per-tier per-seat prices in naira and dollars. What you save here is exactly what checkout charges and the homepage shows." },
              { title: "Watch the red banner", body: "Lapsed schools appear in the red billing banner and in your daily alert digest. Open the school's card to extend, comp or restore." },
              { title: "Stay out of tenant data", body: "Cross-tenant reads run through audited, purpose-built consoles; impersonation is step-up gated and fully audited." },
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
