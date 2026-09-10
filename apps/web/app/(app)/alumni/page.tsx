import type { AlumniPageDto, Serialized } from "@sms/types";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AlumniManager } from "@/components/alumni/AlumniManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function AlumniPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "alumni.manage")) redirect("/dashboard");
  const page = Math.max(1, Number(searchParams?.page ?? 1) || 1);
  // A FAILED READ IS NOT AN EMPTY REGISTER. `?? []` rendered "no alumni yet" —
  // a statement about the school's own history — whenever the request failed,
  // with nothing on screen to tell it from the truth.
  const data = await apiGet<Serialized<AlumniPageDto>>(`/alumni${page > 1 ? `?page=${page}` : ""}`);
  const alumni = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="alumni" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Alumni</>} subtitle={<>Keep in touch with former students and broadcast updates.</>} />
        {data === null ? (
          <Alert variant="destructive">
            <AlertTitle>The alumni register could not be loaded</AlertTitle>
            <AlertDescription className="text-xs">
              This is <strong>not</strong> a record that this school has no alumni. Reload before relying on it.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <AlumniManager alumni={alumni} />

            {/* WHAT IS SHOWN OUT OF WHAT THE SCHOOL HOLDS. The register used to
                stop at 500 with nothing said — and because it reads
                newest-cohort-first, the ones that vanished were the OLDEST,
                which for alumni are the cohorts a school most wants to reach. */}
            {data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Showing {(data.page - 1) * data.pageSize + 1}–
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total}
                </span>
                {pages > 1 && (
                  <span className="flex items-center gap-3">
                    {data.page > 1 && (
                      <Link href={`/alumni?page=${data.page - 1}`} className="underline underline-offset-2">
                        Newer cohorts
                      </Link>
                    )}
                    <span>
                      Page {data.page} of {pages}
                    </span>
                    {data.page < pages && (
                      <Link href={`/alumni?page=${data.page + 1}`} className="underline underline-offset-2">
                        Older cohorts
                      </Link>
                    )}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
