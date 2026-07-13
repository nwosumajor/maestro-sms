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
            { title: "Your account", body: "Change your password and enrol two-factor authentication (recommended for all staff) on the Account page." },
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
