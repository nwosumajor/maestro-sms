import type { FormDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { FormBoard } from "@/components/form/FormBoard";

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
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage ? "Build surveys, feedback, and review forms — collect responses." : "Fill in forms shared with you."}
          </p>
        </div>
        <FormBoard forms={forms} canManage={canManage} />
      </div>
    </AppShell>
  );
}
