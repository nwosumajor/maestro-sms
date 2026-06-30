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

  const [staff, students] = await Promise.all([
    apiGet<{ id: string; name: string }[]>("/users"),
    apiGet<{ id: string; name: string }[]>("/students"),
  ]);
  const map = new Map<string, { id: string; name: string }>();
  for (const u of [...(staff ?? []), ...(students ?? [])]) map.set(u.id, { id: u.id, name: u.name });
  const people = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="certificates" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Certificates &amp; ID cards</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a printable ID card or an award/completion certificate. Each issuance is logged with a serial.
          </p>
        </div>
        <CertificateIssuer people={people} />
      </div>
    </AppShell>
  );
}
