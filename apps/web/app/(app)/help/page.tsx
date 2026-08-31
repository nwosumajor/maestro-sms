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
            // WHO CAN ACTUALLY UNLOCK IT. This said "until an administrator
            // reactivates it", and no administrator in a school can: the only
            // unlock route in the product is
            // `POST /operator/tenants/:schoolId/users/:userId/unlock`, gated on
            // `platform.user.credentials`, which only super_admin holds. There
            // is no school-side unlock anywhere. So a locked-out teacher asked
            // their own office, which had no button to press, and the sentence
            // was what sent them there.
            { title: "Security", body: "Sensitive actions ask you to re-confirm your password (step-up). Staff passwords expire every 30 days; three failed sign-ins lock the account permanently. Your school's own administrators cannot undo that — only the platform operator can, so ask your school to contact support. Never share your login." },
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
              { title: "Take part", body: "Tasks (work assigned to you), Polls (anonymous votes), Discussion (moderated topic groups) and Forms (school surveys) are yours to join. Discipline lets you file a complaint about a classmate or a teacher who teaches you — a person always reviews it, and nothing is ever automatic." },
            ]}
          />
        )}

        {isParent && (
          <Guide
            title="Parents & guardians — following your child"
            description="Everything about your children in one place, plus the approvals only you can give."
            steps={[
              { title: "Your children at a glance", body: "My children lists each linked child; open one for their profile, classes, attendance and results as teachers publish them. Analytics shows the same, summarised per child." },
              { title: "Pay fees from your phone", body: "Fees: open an invoice and pay the outstanding balance by card \u2014 or, where your country has it, by mobile money (M-Pesa, MTN MoMo or Airtel Money). Choose the provider, enter your number, and approve the prompt on your handset; the page waits for you rather than pretending it is done. If you are ever debited and the invoice still shows unpaid, do NOT pay again \u2014 it reconciles itself within the hour." },
              { title: "Or pay by card and bank transfer", body: "Fees: pay by card from your phone \u2014 or by ordinary bank transfer to your child's dedicated account number (shown on the invoice page once the school assigns it; transfers credit the oldest unpaid invoice automatically). The receipt (with the new balance) lands in Notifications and by email, and every posted payment has a downloadable receipt PDF. If the school sets a payment plan, the invoice page shows each part and its due date. Overpayments are flagged to the school's finance staff for refund." },
              { title: "Prepay when it suits you", body: "The invoice page shows your child's credit balance — top it up online any time and the school applies it to invoices as they come due. Useful for paying ahead of term." },
              { title: "Approve scholarship requests", body: "Scholarships: when your child requests a scholarship (or their teacher applies for them), it reaches YOU after the class supervisor. Your approval is also your consent to share their academic record with the sponsor — nothing is submitted without it. You can also start an application for your child yourself. You're notified at every later stage, through to the award." },
              { title: "Absence alerts", body: "You're notified automatically the moment your child is marked absent or late on the register." },
              { title: "Bus & boarding-house alerts", body: "If your child rides the school bus, you're alerted the moment they board for pickup. For boarders, you're notified when an exeat (a pass to leave the boarding house) is approved, with the expected return time. These arrive in Notifications." },
              { title: "Book a meeting with a teacher", body: "Meetings shows the appointment slots teachers have opened. Pick one, choose which child it's about, and book — the teacher is notified straight away. You can cancel from the same page (so can they, and you'll be told)." },
              { title: "Your child's exam hall and seat", body: "Exams shows each child's upcoming exams with hall, time and seat number." },
              // A CHANNEL SWITCH APPLIES TO EVERYTHING, including the notices
              // this used to say were "always sent". `allowedChannels` lets an
              // ESSENTIAL type ignore a category MUTE and then filters by the
              // channel toggles all the same — so a guardian who turns email off
              // gets no fee reminders by email. Said immediately after the
              // sentence about switching channels, "always sent" read as "these
              // reach you whatever you switch off", which is the one thing it
              // does not mean.
              { title: "Choose how we contact you", body: "Account → Notification preferences: switch email, SMS or WhatsApp on or off, and mute categories you don't need (announcements, fee reminders, grade publications…). Fee and security notices ignore category mutes — but switching a CHANNEL off silences everything on it, those included. Your in-app inbox always keeps every notice whatever you switch off." },
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
              { title: "Take the register", body: "Attendance → Take register for your class each morning. Guardians of absent or late students are notified automatically. \u201cToday\u201d means your school\u2019s calendar day, not the server\u2019s \u2014 so an evening register still files against the right date." },
              { title: "Fixing a register later", body: "Up to 7 days old you can correct it directly. Older than that, in the current term, your correction becomes a request a head teacher or administrator approves \u2014 the register records who physically looked at the room, so it is not silently rewritable. Once a term has ended its registers are locked for good, with or without approval." },
              { title: "Teach with the LMS", body: "Classes → Content: publish lessons (structured blocks), materials, quizzes and forums. Tag quizzes and assignments with a subject and term and their scores can flow into report-card continuous assessment. Content revisions are kept — you can revert or clone." },
              { title: "Grade work", body: "Grades: record scores per subject and term. Publishing grades goes through an approval, and report cards are generated from published grades plus attendance." },
              { title: "Review integrity signals", body: "Assessments: cheating-detection raises signals (paste bursts, focus loss, similarity) for YOUR judgement — the system never punishes a student automatically. Grant exemptions for students using assistive technology." },
              { title: "Author CBT exams", body: mod("cbt") ? "CBT exams: build question banks, then schedule timed exams that sample questions per sitting. Auto-marked scores are numbers for YOUR review — you decide what they mean." : "When your school enables the CBT module you can author question banks and timed exams under CBT exams." },
              { title: "Decide scholarship requests", body: "Scholarships: requests from students in the class you supervise wait under “Awaiting your decision” — you are the FIRST stage of the approval chain (then guardian, then principal). You can also apply on behalf of any student you teach. Approve or reject with a note; everyone involved is notified." },
              { title: "Run class games", body: "Games: host a Live Quiz, Hangman or Typing Race for your class, or open a Class Race. Games only ever produce points and practice — never a grade or a record." },
              { title: "Write report-card remarks", body: "Open a student you teach → Report card & remarks: pick the term and write the class teacher's remark. It prints on the report card over a signature line under YOUR name — the head's remark is written by the principal or a school administrator, under theirs." },
              { title: "Rate skills and behaviour", body: "On the same pupil's record: twenty traits in four groups, each 1 to 5, entered in one go. Grades shows a per-class list of who still needs rating (“17 of 20”, not a tick) so a half-finished set is visible. They print beside the marks and are NEVER averaged into them." },
              { title: "Offer parent meeting slots", body: "Meetings: open time slots and parents book them for a chat about their child. You're notified on every booking and cancellation; withdraw a slot any time before it's booked." },
              { title: "See your week", body: "Timetable: switch between the class grid, BY TEACHER (your own week end to end) and BY ROOM. Your standing teaching load is shown alongside, and the grid prints." },
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
              { title: "Or let it build the timetable for you", body: "Timetable → Auto-generate: set how many lessons a week each subject offering needs, mark when teachers are unavailable, and fix a room to an offering if it must have one. The solver builds a conflict-free grid from those constraints and SHOWS ITS WORKING — how many lessons it placed, and for anything it could not, which constraint blocked it. Review the result and hand-tweak as usual; tick “replace existing lessons” only if you mean to start over." },
              { title: "Configure fees", body: "Fees: build your fee catalog and issue invoices. Parents pay online by card \u2014 and by mobile money where your country has it (M-Pesa, MTN MoMo, Airtel Money). Money settles to the bank account you register; large manual postings and all refunds need a second approver." },
              { title: "Review admissions", body: "Admin → Admissions: public applications arrive quarantined from student data until you review them. If you charge an admission-form fee, paid/unpaid status shows on each application." },
              { title: "Brand your portal", body: "Admin → Branding: upload your school logo (square, 128–2048px) and pick your brand colour and font — it appears for every member and on generated documents." },
              { title: "Cover for absent teachers", body: "Timetable → Teacher cover: pick a date range and the system lists every lesson whose teacher is on approved leave, so nothing is left unattended. Assign a reliever — it refuses anyone already teaching that period and notifies whoever you pick." },
              { title: "Run exams", body: "Exams: schedule a sitting (hall, date, time, seats), seat a whole class in one click, and roster invigilators. Editing a sitting is non-destructive, clashes are detected before you commit, and you can print a hall pack (seating chart + attendance sheet). Students and parents see only their own hall, time and seat; invigilators see their duties." },
              { title: "Promote the school at year end", body: "Classes → Promotion: stage a batch for a class and it moves NOTHING until a different senior approves it. Each pupil can be set individually — promoted, RETAINED in the present class, or moved down to a class you name. Every outcome is somebody's decision recorded, never computed from marks, and the approved decision prints on that term's report cards." },
              { title: "Messages that did not arrive", body: "Notifications: if an email bounced, a phone number was rejected, or a message was skipped because the school had run out of credits, it is listed there with the reason. Everyone listed still has the message in their in-app inbox — it is the email or SMS copy that failed. The panel stays hidden when there is nothing wrong." },
              { title: "Move the school on a term", body: "Classes: when a term ends, roll the school on to the next one. It moves the CURRENT pointer only \u2014 past terms, their registers and their results stay exactly as they were. A daily sweep does it automatically if you forget." },
              { title: "Chase incomplete student profiles", body: "Students: a completion figure shows what is still missing (contacts, medical, guardian), and a daily nudge goes out until it is submitted." },
              { title: "The profile review chain", body: "On a pupil's record: the family or office SUBMITS the completed profile, the class supervisor CHECKS it, then an administrator APPROVES it — each stage on the same panel, showing the current state (Not submitted / Waiting for review / Changes requested / Approved). A reviewer asking for changes writes a note saying what, and it goes back to be resubmitted." },
              { title: "Run the desk with ID cards", body: "Scan: point a handheld scanner at a student or staff ID card and it resolves to that member \u2014 for the library desk, the gate, or an exam hall. Checking a student IN also marks them present in today\u2019s register. A card from another school returns nothing at all."},
              { title: "Correct an old register", body: "You hold the approval for attendance amendments, so registers older than 7 days you can edit directly \u2014 and you are who a teacher\u2019s correction comes to. Approvals: look for attendance amendments alongside the other chains." },
              { title: "Require 2FA for staff", body: "Admin → Roles → Require two-factor authentication for staff: when on, every staff member must set up an authenticator app before they can use the app. Students and parents are unaffected." },
              { title: "Find anything fast", body: "The search box in the header jumps straight to a student, staff member, class or invoice — no need to navigate the module first." },
              { title: "Mind the guardrails", body: "Admin → Audit is the searchable log of every sensitive action; Admin → Security handles just-in-time privilege elevation (approved by a DIFFERENT person); Admin → Recertification reviews who still needs their access; Admin → Privacy handles NDPR data-export and erasure requests." },
              { title: "Check your subscription", body: "Billing: your plan, per-student pricing (monthly / per-term −5% / per-year −15%), payment history and renewal — paying activates instantly." },
              { title: "Delegate with junior admins", body: "Appoint a junior admin for day-to-day work (records, attendance, timetable, fee RECORDING, admissions review) while approvals stay senior-only. Appointing one — or adding roles to one — raises an approval that a DIFFERENT senior (the other admin or the principal) must confirm under Approvals." },
            ]}
          />
        )}

        {/* Schools outside Nigeria. Deliberately leadership-only: most of it is
            read-only from the school's side (the operator sets the region), so
            the useful content is "what this changes for you" and "who to ask". */}
        {isLeadership && (
          <Guide
            title="Schools outside Nigeria"
            description="What the platform adapts to your country — and what it deliberately refuses to guess."
            steps={[
              { title: "Your region is set for you", body: "Country, timezone, currency, privacy regime, academic calendar shape and grade weighting belong to your school record. They are set by the platform operator, not from inside the app \u2014 changing a region silently moves every register\u2019s day boundary and switches the privacy rules, so it is not a self-service setting. Ask support to change it." },
              { title: "Dates follow YOUR day", body: "\u201cToday\u201d means today where your school is. A register taken at 8am in Singapore or 7pm in Toronto files against the right local date, and money, dates and numbers display in your locale for everyone in your school." },
              { title: "Your academic year has your shape", body: "Three terms, two semesters, four quarters or trimesters \u2014 whichever your country uses. Grade weighting (exam / mid-term / assignment / note) is yours too; the weights must total 100 or the platform falls back to its default rather than producing a wrong total." },
              { title: "Fees in your own currency", body: "Invoices are raised and settled in your currency, and are only ever settled in the currency they were raised in. Where cards cannot reach your currency, mobile money usually can \u2014 see the finance guide." },
              { title: "Payroll: only where it is certain", body: "Statutory payroll is implemented for Nigeria and the United Kingdom. Anywhere else, a payroll run is REFUSED rather than computed with the wrong tax rules \u2014 a payslip that is wrong about tax reaches both an employee and a revenue authority. If you need your country added, ask support; until then run payroll outside the platform." },
              { title: "GDPR schools: the breach register", body: "Admin → Compliance appears where your region is under GDPR. It runs Article 33\u2019s 72-hour clock from when your school BECAME AWARE, tracks whether the people affected were told (which is a separate duty from telling the regulator), and states plainly what is missing \u2014 an absent DPO, gaps in consent \u2014 as loudly as what is in place." },
            ]}
          />
        )}

        {/* The ROLE, not a permission set. `admission.review && !rbac.manage`
            also caught the HR MANAGER, who was being shown a guide to records,
            attendance, timetable and fee RECORDING — work that is not theirs and,
            for fees, not even permitted to them. A guide named after a role is
            gated on that role. */}
        {is("junior_admin") && (
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
              { title: "Attendance amendments", body: "A teacher correcting a register more than 7 days old raises a request here. Registers in a term that has ENDED cannot be amended at all \u2014 not by you, not with approval \u2014 so if one is wrong the answer is a note on the record, not an edit." },
              { title: "One person, one stage", body: "You cannot act twice on the same request, and you cannot approve something you initiated — the engine enforces separation of duties." },
              { title: "Approve or reject with a note", body: "Your decision advances the request to the next stage (or ends it). The requester is notified automatically at the end." },
              // The head's remark is refused to anyone who is not a principal or
              // school administrator — a HEAD TEACHER holds only grade.read. This
              // step used to tell every approver it was theirs to write, sending
              // the one role it names most directly at a button that refuses them.
              ...(isLeadership
                ? [{ title: "Sign off report cards", body: "Open a student → Report card & remarks: the head's remark is yours to write (the class teacher writes theirs). Both print over a signature line under the name of whoever wrote them, and any approved promotion decision is stamped beside yours." }]
                : [{ title: "Report-card remarks are not yours", body: "The head's remark is written by the principal or a school administrator, and the class teacher writes the other — if you teach or supervise a class you write that one on your own pupils. Your sign-off on results is the grade-publishing approval, not a remark." }]),
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
              { title: "Mobile money, where your country has it", body: "On the invoice page a parent can pay from their phone \u2014 M-Pesa in Kenya and Tanzania, MTN MoMo in Ghana, Uganda, Cameroon, C\u00f4te d\u2019Ivoire, Rwanda and Zambia, Airtel Money in Kenya, Uganda and Tanzania. The rails offered follow YOUR school\u2019s country; nothing is shown where it would not work. The prompt goes to their handset, so the screen waits for them to approve it rather than claiming success." },
              { title: "Why a payment can be refused outright", body: "An invoice is only ever settled in the currency it was raised in. If a gateway cannot handle that currency it refuses the charge and says so, instead of quietly billing in its own \u2014 which would take the right number of the wrong money and mark the invoice paid. If card is refused, mobile money usually covers the same country." },
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

        {/* The report card is assembled from four separate acts by three
            different people — marks, behaviour, remarks, promotion — and nobody
            could see the whole shape of it anywhere. */}
        {can("grade.write") && (
          <Guide
            title="Report cards — what goes on one, and who puts it there"
            description="Four separate acts by three different people, assembled into one document."
            steps={[
              { title: "The marks", body: "Grades: each subject carries four components — exam, mid-term test, assignment and class note. The card prints them as C.A. (the three continuous-assessment parts added together) and Exam, with the total, the grade letter and the pupil's position in that subject. What each column is out of is printed in the table itself." },
              { title: "How the class did", body: "Beside each pupil's mark the card shows the class average and the lowest/highest scored. A parent reading \u201c65\u201d learns something quite different when the class average is 49 than when it is 82." },
              { title: "Skills and behaviour", body: "Twenty traits in four groups — personal development, sense of responsibility, social development and psychomotor skills — each rated 1 to 5. Open a pupil's record to enter them; Grades shows a per-class list of who still needs rating, as \u201c17 of 20\u201d rather than a tick, so nothing is quietly half-done. These are never averaged into any mark: a behaviour rating and a mathematics score are different kinds of statement about a child." },
              { title: "Who may rate them", body: "The pupil's class teacher or supervisor, or a school administrator. Every rating records who gave it and when, and can be corrected — a mis-click on a child's honesty must be fixable." },
              { title: "The scale is printed, not assumed", body: "The card states what 1 to 5 mean in words, and the grade key states every band with its range and its word (\u201cA1 75\u2013100 excellent\u201d). A letter a family cannot read has not really reported anything." },
              { title: "The two remarks", body: "Open a pupil \u2192 Report card & remarks. The class teacher writes theirs; the principal or a school administrator writes the head's. Both print over a signature line UNDER THE NAME of whoever wrote them — a comment about a child is somebody's judgement, not the building's." },
              { title: "The year, not just the term", body: "Beneath the term's marks the card shows each subject across every term of the session: each term's total, the annual average, its grade and word, and the pupil's place in that subject for the year — plus the cumulative score. A third-term card that showed only third-term marks would say nothing about the year." },
              { title: "The promotion line", body: "If a promotion has been decided and approved for that term, it is stamped beside the principal's comment — PROMOTED TO …, TO REPEAT THE CLASS, or GRADUATED. It is never derived from the averages above it: the system does not award a year, a person does, and if nobody has decided the line simply does not appear." },
              { title: "Generate and share", body: "Generating a card also files a copy in the pupil's Documents, so the family can retrieve it themselves rather than relying on the copy you downloaded. Guardians are notified only once the file really exists." },
              { title: "Attendance on the card", body: "Term-scoped, and it leads with how many times the school actually opened — \u201cpresent: 46\u201d means nothing without the denominator. Term start, term end and next term's start print alongside." },
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
              { title: "Run payroll", body: "HR → Payroll: a run snapshots active salaries with your COUNTRY's statutory deductions and loan recoveries computed; a second person finalises. Payslips, bank-export and remittance CSVs come from the run, and which statutory schedules you can file follows your country too — a run is refused outright for a country whose rules are not implemented, rather than computed with another country's. 13th-month/bonus runs are supported." },
              { title: "Exits are settled, not deleted", body: "Offboarding computes the final settlement (pro-rata pay + unused leave − outstanding loans) under maker-checker, auto-opens the offboarding checklist, and the record is retained as statutory history." },
            ]}
          />
        )}

        {/* Three guides, not one. A librarian was being shown hostel roll-call
            and fleet scheduling because all three shared a gate — and none of
            these roles can act on the other two: a warden holds hostel.manage
            only, a driver transport.read only, a librarian library.manage only.
            A guide that describes work you cannot do teaches people to skim. */}
        {can("hostel.manage") && (
          <Guide
            title="Hostel — wardens"
            description="Your house: who sleeps where, who is signed out, and what needs fixing."
            steps={[
              { title: "Know your house", body: "Hostel: rooms, bed availability and current allocations. A warden sees their OWN hostel; a head warden sees every hostel in the school." },
              { title: "Allocate and transfer", body: "Give a boarder a bed, or move them between rooms. A room at capacity is refused rather than overfilled — two wardens allocating the last bed at the same moment cannot both succeed." },
              { title: "Take the roll-call", body: "Record who is present in the house. It is a hostel record and separate from the classroom register." },
              { title: "Exeat passes need a second warden", body: "You raise an exeat; a DIFFERENT warden approves it, and the guardian is notified when it is granted. An exeat still out past its return time is flagged to you by a daily sweep." },
              { title: "Log maintenance and incidents", body: "Faults and incidents are recorded against the room, so a recurring problem is visible rather than remembered." },
              { title: "Hostel fees go through approval", body: "A hostel fee run does not bill on your say-so: it raises a fee-schedule request that someone with fee approval confirms first." },
            ]}
          />
        )}

        {can("transport.read") && (
          <Guide
            title="Transport — drivers and the fleet"
            description={can("transport.manage") ? "Your fleet: vehicles, routes, trips and costs." : "Your vehicle, your route and the children aboard."}
            steps={[
              { title: "Your vehicle and route", body: "Transport: the vehicle assigned to you, its route and today's passenger list." },
              { title: "Confirm every child aboard", body: "Mark each child on at pickup and off at drop-off. Their guardian is alerted automatically — this is the record that answers \u201cdid my child get on the bus\u201d." },
              { title: "Share the bus location", body: "Start sharing when you set off so families can see where the bus is. It stops when the trip ends." },
              ...(can("transport.manage")
                ? [
                    { title: "Run the fleet", body: "Vehicles, drivers, routes and stops are yours to manage, along with AM/PM trip scheduling." },
                    { title: "Changing a route alerts families", body: "Editing a route notifies the parents of every child on it automatically — you do not have to tell them separately." },
                    { title: "Log fuel and maintenance", body: "Costs recorded against a vehicle build the running-cost picture in analytics." },
                    { title: "Transport fees go through approval", body: "A transport fee run raises a fee-schedule request that someone with fee approval confirms before anything bills." },
                  ]
                : []),
            ]}
          />
        )}

        {can("library.manage") && (
          <Guide
            title="Library — librarians"
            description="The catalogue, loans and fines."
            steps={[
              { title: "Keep the catalogue", body: "Library: add titles and copies. A book with loan history cannot be deleted — the borrowing record outlives the stock decision." },
              { title: "Issue and return", body: "A copy must actually be available to issue, and the claim is atomic: two desks issuing the last copy at the same moment cannot both succeed. Returning restores availability." },
              { title: "Fines", body: "Overdue loans accrue the fine your school configures; settle them from the loan." },
              { title: "Use the scanner", body: "Scan: point a handheld reader at a student or staff ID card to pull up the member at the desk instead of typing a name." },
            ]}
          />
        )}

        {can("workflow.veto") && (
          <Guide
            title="Board — oversight"
            description="Read-only visibility with one deliberate power."
            steps={[
              { title: "See without touching", body: "You can read classes, grades, workflows, fees, scholarships and documents across the school — but not modify them." },
              { title: "The veto", body: "You may veto a request while it is still under review, or after it has been approved — the one active power the board holds, and it is audit-logged like everything else. Vetoing a request that is still under review STOPS it: it never takes effect and there is nothing to unwind." },
              // Says what it DOES NOT do. A veto lands after the approval has
              // already taken effect — the role was granted, the charges are on
              // families' invoices, the marks are published — and it records the
              // board's decision rather than reversing it. Proven live: a vetoed
              // junior-admin appointment left the role on the account. A board
              // member who believes the button undoes the act will not go and
              // ask anyone to undo it.
              { title: "After approval, a veto records — it does not reverse", body: "If you veto a request that was ALREADY APPROVED, whatever the approval did has already happened: the role was granted, the charge is on the family's invoice, the marks were published. Vetoing does not undo it — ask the relevant office to reverse it, and everyone who approved it is told at the same time. Veto it while it is still under review and this does not arise." },
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
              { title: "Support without power-grabs", body: "You can look up a school\u2019s user accounts and clear login lockouts for support. Credential resets, impersonation and student-data exports are owner-only, step-up gated and fully audited." },
              { title: "Hiring platform staff (owner only)", body: "Operator → Platform staff: invite a manager by name and email. They are created with two-factor authentication mandatory. You get a set-password LINK and a one-time password \u2014 use either, and hand it over yourself if the console says the email was not sent. Both expire in 7 days; \u201cResend invite\u201d issues a fresh pair and kills the old one." },
              { title: "A manager\u2019s standing role is the bare floor", body: "By default a manager can view tenants and read notifications. Nothing else. Every real duty \u2014 provisioning, onboarding triage, audit reads, account unlock, grace, plan changes \u2014 is LENT to them for a fixed window and expires on its own. The staff list shows exactly what each person holds today and how many days remain." },
              { title: "Taking a duty back", body: "Revoking a single grant applies on that manager\u2019s very next request \u2014 they do not have to sign out. \u201cHand back all duties\u201d does the lot in one click, which is what you want when someone leaves or loses a laptop; it leaves the account working, so disabling it is a separate, deliberate decision." },
              { title: "What can never be lent", body: "Impersonation, credential resets, pricing, plan credentials, student records and hiring staff are not delegable at all \u2014 lending one for a week is giving it away. They stay with you." },
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
