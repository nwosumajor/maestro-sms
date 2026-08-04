// The screen a school puts in front of its data-protection officer.
//
// Deliberately shows what is MISSING as loudly as what is present: a compliance
// page that only lists what you have done reads as a clean bill of health, which
// is the opposite of what it is for.

import type { BreachIncidentDto, CompliancePostureDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTime } from "@/lib/format";
import { BreachRegister } from "@/components/privacy/BreachRegister";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "privacy.compliance.manage")) redirect("/admin");

  const [posture, breaches] = await Promise.all([
    apiGet<Serialized<CompliancePostureDto>>("/privacy/compliance/posture"),
    apiGet<Serialized<BreachIncidentDto>[]>("/privacy/compliance/breaches"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Data protection</>}
            subtitle={
              <>
                What this school can tell its data-protection officer: the regime it operates under,
                who is accountable, and whether every personal-data breach was notified in time.
              </>
            }
          />
          <Link href="/admin" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Admin
          </Link>
        </div>

        {!posture ? (
          <Alert variant="info">
            <AlertTitle>Not available</AlertTitle>
            <AlertDescription>The compliance posture could not be read.</AlertDescription>
          </Alert>
        ) : (
          <>
            {/* The failings first. A page that leads with what you have done is a
                page nobody acts on. */}
            {(posture.dpoMissing || posture.breaches.overdue > 0 || posture.breaches.subjectsUnnotified > 0) && (
              <div className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
                {posture.breaches.overdue > 0 && (
                  <p className="font-semibold text-destructive">
                    ⚠ {posture.breaches.overdue} breach{posture.breaches.overdue === 1 ? "" : "es"} past the 72-hour
                    notification deadline with no notification and no recorded reason for not notifying.
                  </p>
                )}
                {posture.breaches.subjectsUnnotified > 0 && (
                  <p className="font-semibold text-destructive">
                    ⚠ {posture.breaches.subjectsUnnotified} high-risk breach
                    {posture.breaches.subjectsUnnotified === 1 ? "" : "es"} where the authority was told but the
                    affected people were not (Art. 34).
                  </p>
                )}
                {posture.dpoMissing && (
                  <p className="text-destructive">
                    No data-protection officer is recorded. A school processing children&apos;s data at scale is
                    required to designate one — ask the platform operator to set the DPO contact.
                  </p>
                )}
              </div>
            )}

            {posture.regimeModelled === false && posture.regimeNote && (
              <Alert variant="info">
                <AlertTitle>Your country&rsquo;s data-protection law is not modelled here</AlertTitle>
                <AlertDescription>{posture.regimeNote}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* The regime card used to print a bare key — and for 34 of 37
                  countries that key was "NONE", which reads as "no privacy law
                  applies here". It now names the regime and, when the country is
                  not modelled, says so in as many words. */}
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Regime</CardDescription>
                  <CardTitle className="text-lg">{posture.regimeLabel ?? posture.regime}</CardTitle>
                  <CardDescription>
                    {posture.country}
                    {posture.regimeModelled === false ? " — not modelled here" : ""}
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  {/* POPIA's is an "Information Officer". Asking a South African
                      school for a "DPO" asks for the wrong thing by name. */}
                  <CardDescription>{posture.officerTitle ?? "Data-protection officer"}</CardDescription>
                  <CardTitle className="text-base">{posture.dpoName ?? "—"}</CardTitle>
                  <CardDescription>{posture.dpoEmail ?? "not recorded"}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Telemetry retention</CardDescription>
                  <CardTitle className="tnum text-2xl">{posture.integrityRetentionDays}</CardTitle>
                  <CardDescription>days, then purged automatically</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Erasure requests pending</CardDescription>
                  <CardTitle className="tnum text-2xl">{posture.erasurePending}</CardTitle>
                  <CardDescription>
                    <Link href="/admin/privacy" className="underline">
                      review
                    </Link>
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Consent coverage</CardTitle>
                <CardDescription>
                  Guardian consent on file for behavioural telemetry. The number WITHOUT is the
                  lawful-basis question a DPO asks first.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-6 text-sm">
                <span className="tnum">
                  <span className="text-2xl font-semibold">{posture.consent.recorded}</span> recorded
                </span>
                <span className="tnum">
                  <span
                    className={`text-2xl font-semibold ${posture.consent.studentsWithout > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}
                  >
                    {posture.consent.studentsWithout}
                  </span>{" "}
                  pupils with none
                </span>
              </CardContent>
            </Card>

            <BreachRegister initial={breaches ?? []} />

            <p className="text-xs text-muted-foreground">
              Breach register last read {dateTime(new Date().toISOString())}. Every entry here is
              audit-logged; discovery times cannot be edited once recorded, because the whole value of
              the record is that it fixes when the 72-hour clock started.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
