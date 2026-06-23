import type { ContactDto, MedicalRecordDto, StudentProfileDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
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
import { PrivacyPanel } from "@/components/privacy/PrivacyPanel";
import { ReportCardButton } from "@/components/reportcards/ReportCardButton";

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
  // Each call returns null if the caller lacks the permission (RBAC) — we hide
  // the section rather than fail the page.
  const [profile, contacts, medical] = await Promise.all([
    apiGet<Profile>(`/students/${params.id}/profile`),
    apiGet<Contact[]>(`/students/${params.id}/contacts`),
    apiGet<Medical>(`/students/${params.id}/medical`),
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

        <StudentAdmin
          studentId={params.id}
          canProfile={hasPermission(user.permissions, "student.profile.write")}
          canContact={hasPermission(user.permissions, "student.contact.write")}
          canMedical={hasPermission(user.permissions, "student.medical.write")}
          profile={profile}
          contacts={contacts}
          medical={medical}
        />

        {hasPermission(user.permissions, "grade.read") && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Report card</CardTitle>
              <CardDescription>Generates a PDF from grades + attendance and notifies guardians.</CardDescription>
            </CardHeader>
            <CardContent>
              <ReportCardButton studentId={params.id} />
            </CardContent>
          </Card>
        )}

        <PrivacyPanel studentId={params.id} />
      </div>
    </AppShell>
  );
}
