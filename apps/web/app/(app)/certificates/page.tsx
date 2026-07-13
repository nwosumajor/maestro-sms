import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { CertificateIssuer } from "@/components/certificate/CertificateIssuer";

export const dynamic = "force-dynamic";

export default async function CertificatesPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "certificate.issue")) redirect("/dashboard");

  // Categorised: the issuer picks Student or Staff first, then a name from ONLY
  // that list — two server-filtered fetches, never one mixed directory.
  type Person = { id: string; name: string };
  const [staffList, studentList] = await Promise.all([
    apiGet<Person[]>("/users?kind=staff"),
    apiGet<Person[]>("/students"),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  const students = [...(studentList ?? [])].sort(byName);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="certificates" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Certificates &amp; ID cards</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a printable ID card or an award/completion certificate. Each issuance is logged with a serial.
          </p>
        </div>
        <CertificateIssuer staff={staff} students={students} />
      </div>
    </AppShell>
  );
}
