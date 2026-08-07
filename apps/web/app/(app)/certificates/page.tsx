import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { CertificateIssuer } from "@/components/certificate/CertificateIssuer";
import { ClassIssuer } from "@/components/certificate/ClassIssuer";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function CertificatesPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "certificate.issue")) redirect("/dashboard");

  // Categorised: the issuer picks Student or Staff first, then a name from ONLY
  // that list — two server-filtered fetches, never one mixed directory.
  type Person = { id: string; name: string };
  const [staffList, studentList] = await Promise.all([
    // /users requires class.write — narrower than this page's own gate.

    hasPermission(user.permissions, "directory.people.read") ? apiGet<Person[]>("/directory/people?kind=staff") : Promise.resolve(null),
    // Classes for the bulk issuer. The roster itself is NOT prefetched — the
    // single-issue picker searches for a pupil.
    apiGet<Person[]>("/classes/mine"),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  const classes = [...(studentList ?? [])].sort(byName);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="certificates" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Certificates &amp; ID cards</>} subtitle={<>Generate a printable ID card or an award/completion certificate. Each issuance is logged with a serial.</>} />
        <CertificateIssuer staff={staff} />
        <ClassIssuer classes={classes} />
      </div>
    </AppShell>
  );
}
