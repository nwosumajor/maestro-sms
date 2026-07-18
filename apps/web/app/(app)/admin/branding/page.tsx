import type { SchoolBrandingDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { BrandingManager } from "@/components/branding/BrandingManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function BrandingPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "school.branding.manage")) redirect("/dashboard");
  const branding = (await apiGet<Serialized<SchoolBrandingDto>>("/schools/branding")) ?? { slug: "", logoKey: null, logoUrl: null, brandHue: null, brandSat: null, brandLight: null, fontFamily: null };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>School branding</>} subtitle={<>Upload your school&apos;s logo for the branded login page. It&apos;s a paid-plan perk — automatically hidden if the subscription lapses past the grace period.</>} />
        <BrandingManager initial={branding} slug={branding.slug} />
      </div>
    </AppShell>
  );
}
