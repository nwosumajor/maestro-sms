import type { AlumnusDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AlumniManager } from "@/components/alumni/AlumniManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function AlumniPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "alumni.manage")) redirect("/dashboard");
  const alumni = (await apiGet<Serialized<AlumnusDto>[]>("/alumni")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="alumni" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Alumni</>} subtitle={<>Keep in touch with former students and broadcast updates.</>} />
        <AlumniManager alumni={alumni} />
      </div>
    </AppShell>
  );
}
