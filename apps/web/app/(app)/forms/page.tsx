import type { FormDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { FormBoard } from "@/components/form/FormBoard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function FormsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "form.respond")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "form.manage");
  const forms = (await apiGet<Serialized<FormDto>[]>("/forms")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="forms" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Forms</>} subtitle={<>{canManage ? "Build surveys, feedback, and review forms — collect responses." : "Fill in forms shared with you."}</>} />
        <FormBoard forms={forms} canManage={canManage} />
      </div>
    </AppShell>
  );
}
