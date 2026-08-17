import type { ContactDto, IntegrityExemptionDto, MedicalRecordDto, StudentProfileDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortDate } from "@/lib/format";
import { StudentAdmin } from "@/components/sis/StudentAdmin";
import { ProfileReviewChain } from "@/components/sis/ProfileReviewChain";
import { GuardianLinks } from "@/components/sis/GuardianLinks";
import { ExemptionPanel } from "@/components/assessment/ExemptionPanel";
import { PrivacyPanel } from "@/components/privacy/PrivacyPanel";
import { ReportCardButton } from "@/components/reportcards/ReportCardButton";
import { RemarksEditor } from "@/components/reportcards/RemarksEditor";
import { TraitRatings } from "@/components/gradebook/TraitRatings";
import type { AcademicSessionDto } from "@sms/types";

export const dynamic = "force-dynamic";

type Profile = Serialized<StudentProfileDto>;
type Contact = Serialized<ContactDto>;
type Medical = Serialized<MedicalRecordDto>;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function StudentProfilePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  // Same gate as the section index — a detail page is reachable by URL
  // whether or not the list that links to it was.
  if (!hasPermission(user.permissions, "student.profile.read")) redirect("/dashboard");
  // Each call returns null if the caller lacks the permission (RBAC) — we hide
  // the section rather than fail the page.
  const canReadGrades = hasPermission(user.permissions, "grade.read");
  const canReadExemptions = hasPermission(user.permissions, "integrity.exemption.read");
  const [profile, contacts, medical, sessions, exemptions] = await Promise.all([
    apiGet<Profile>(`/students/${params.id}/profile`),
    apiGet<Contact[]>(`/students/${params.id}/contacts`),
    apiGet<Medical>(`/students/${params.id}/medical`),
    canReadGrades ? apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions") : Promise.resolve(null),
    canReadExemptions
      ? apiGet<Serialized<IntegrityExemptionDto>[]>(`/integrity/exemptions?studentId=${params.id}`)
      : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="students" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Link href="/students" className="text-sm text-muted-foreground hover:underline">← Students</Link>
          <div className="flex gap-3 text-sm">
            <Link href={`/attendance?studentId=${params.id}`} className="font-medium text-primary hover:underline">Attendance</Link>
          </div>
        </div>

        {profile === null ? (
          <Alert variant="info">
            <AlertTitle>No profile</AlertTitle>
            <AlertDescription>
              This student has no profile yet, or you cannot view it.
            </AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profile</CardTitle>
              <CardDescription>Admission {profile.admissionNumber || "—"}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Date of birth" value={shortDate(profile.dateOfBirth)} />
                <Field label="Gender" value={profile.gender} />
                <Field label="Phone" value={profile.phone} />
                <Field label="Email" value={profile.email} />
                <Field label="Address" value={profile.addressLine1} />
                <Field label="City" value={profile.city} />
              </dl>
            </CardContent>
          </Card>
        )}

        {contacts && contacts.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Emergency contacts</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{c.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.relationship}</td>
                      <td className="px-4 py-2.5">{c.phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {medical && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Medical record</CardTitle>
              <CardDescription>Sensitive — every access to this section is audit-logged.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Blood group" value={medical.bloodGroup} />
                <Field label="Allergies" value={medical.allergies} />
                <Field label="Conditions" value={medical.conditions} />
                <Field label="Medications" value={medical.medications} />
                <Field label="Dietary notes" value={medical.dietaryNotes} />
              </dl>
            </CardContent>
          </Card>
        )}

        {/* Submit → supervisor check → office approval. Every control is offered
            on the permission its own endpoint requires; the server stays the
            authority (the supervisor stage is relationship-scoped and 404s a
            non-supervisor, and approval is refused until the check is done). */}
        <ProfileReviewChain
          studentId={params.id}
          canSubmit={hasPermission(user.permissions, "student.profile.write")}
          canReview={hasPermission(user.permissions, "student.profile.read")}
          canApprove={hasPermission(user.permissions, "rbac.manage")}
        />

        <StudentAdmin
          studentId={params.id}
          canProfile={hasPermission(user.permissions, "student.profile.write")}
          canContact={hasPermission(user.permissions, "student.contact.write")}
          canMedical={hasPermission(user.permissions, "student.medical.write")}
          profile={profile}
          contacts={contacts}
          medical={medical}
        />

        {/* Who the school is actually sending things to. Above the academic
            cards because it is the answer to "why did the family not know". */}
        <GuardianLinks studentId={params.id} />

        {/* Skills and behaviour for the CURRENT term, beside the remarks that
            print next to them. Read scope is the report card's own; only the
            class teacher or a school administrator may record them. */}
        {canReadGrades && (
          <TraitRatings
            studentId={params.id}
            termId={sessions?.flatMap((s) => s.terms).find((t) => t.isCurrent)?.id ?? null}
            termName={sessions?.flatMap((s) => s.terms).find((t) => t.isCurrent)?.name ?? null}
            canEdit={hasPermission(user.permissions, "grade.write")}
          />
        )}

        {canReadGrades &&
          (sessions && sessions.length > 0 ? (
            <RemarksEditor
              studentId={params.id}
              sessions={sessions}
              canWrite={hasPermission(user.permissions, "grade.write")}
              canHead={["principal", "school_admin", "super_admin"].some((r) => user.roles.includes(r))}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Report card</CardTitle>
                <CardDescription>Generates a PDF from grades + attendance and notifies guardians.</CardDescription>
              </CardHeader>
              <CardContent>
                <ReportCardButton studentId={params.id} />
              </CardContent>
            </Card>
          ))}

        {canReadExemptions && (
          <ExemptionPanel
            studentId={params.id}
            // The profile DTO carries no name (this page titles itself "Profile" and
            // shows the admission number). The exemption rows do carry it.
            studentName={exemptions?.[0]?.studentName ?? "this pupil"}
            initial={exemptions}
            canWrite={hasPermission(user.permissions, "integrity.exemption.write")}
          />
        )}

        <PrivacyPanel studentId={params.id} />
      </div>
    </AppShell>
  );
}
