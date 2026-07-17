// Operator SCHOOL PROFILE — the complete picture of one onboarded school:
// identity + proprietor, every admin/principal contact, subscription/billing
// detail, payment history, enabled modules and fee-settlement posture.
// Gated platform.tenants.read; management actions live on /operator.

import type { SchoolProfileDto, Serialized } from "@sms/types";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type Profile = Serialized<SchoolProfileDto>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

function ContactList({ people }: { people: Profile["admins"] }) {
  if (people.length === 0) return <span className="text-sm text-muted-foreground">None on record</span>;
  return (
    <ul className="space-y-1.5">
      {people.map((c) => (
        <li key={c.email} className="text-sm">
          <span className="font-medium">{c.name}</span>
          <span className="text-muted-foreground"> · {c.email}{c.phone ? ` · ${c.phone}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function OperatorSchoolProfilePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  const s = await apiGet<Profile>(`/operator/schools/${params.id}/profile`);
  if (!s) notFound();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">{s.name}</h1>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{s.slug}</span> · onboarded {shortDate(s.onboardedAt)}
              {" · "}
              <Badge variant={s.status === "ACTIVE" ? "secondary" : "destructive"}>{s.status}</Badge>
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/operator/schools" className="text-primary hover:underline">← Directory</Link>
            <Link href="/operator" className="text-primary hover:underline">Operator console</Link>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">School & proprietor</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Owner / proprietor">{s.ownerName ?? "—"}</Field>
              <Field label="Owner's phone">{s.ownerPhone ?? "—"}</Field>
              <Field label="Address">{s.address ?? "—"}</Field>
              <Field label="People">
                {s.students} students · {s.staff} staff · {s.users} accounts
              </Field>
              {s.referredBy && <Field label="Referred by">{s.referredBy}</Field>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Subscription & billing</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Plan">
                <Badge variant="outline">{s.plan}</Badge>{" "}
                {s.effectivePlan !== s.plan && (
                  <span className="text-xs text-muted-foreground">(running as {s.effectivePlan})</span>
                )}
              </Field>
              <Field label="Billing status">
                <Badge variant={s.subscriptionStatus === "PAST_DUE" ? "destructive" : "secondary"}>
                  {s.subscriptionStatus.replace("_", " ")}
                </Badge>
              </Field>
              <Field label="Current period ends">{s.currentPeriodEnd ? shortDate(s.currentPeriodEnd) : "—"}</Field>
              <Field label="Last payment">{s.lastPaymentAt ? shortDate(s.lastPaymentAt) : "never"}</Field>
              <Field label="Billed seats">{s.seats ?? "—"}</Field>
              <Field label="Cycle price">
                {s.priceMinor != null ? money(s.priceMinor, s.currency ?? "NGN") : "—"} <span className="text-xs text-muted-foreground">/ {s.billingCycle}</span>
              </Field>
              <Field label="Outstanding seat arrears">
                {s.outstandingMinor > 0 ? (
                  <span className="font-medium text-destructive">{money(s.outstandingMinor)}</span>
                ) : (
                  "none"
                )}
              </Field>
              <Field label="Auto-renew">
                {s.autoRenew ? `On${s.cardLast4 ? ` (card •••• ${s.cardLast4})` : ""}` : "Off"}
              </Field>
              {s.graceDays != null && <Field label="Grace override">{s.graceDays} days</Field>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">School admins</CardTitle></CardHeader>
            <CardContent><ContactList people={s.admins} /></CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Principals</CardTitle></CardHeader>
            <CardContent><ContactList people={s.principals} /></CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enabled modules ({s.modules.length})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {s.modules.map((m) => (
                <Badge key={m} variant="outline" className="font-mono text-xs">{m}</Badge>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Fee collection</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Settlement bank">
                {s.settlementBankName
                  ? `${s.settlementBankName}${s.settlementAccountLast4 ? ` •••• ${s.settlementAccountLast4}` : ""}`
                  : "Not configured"}
              </Field>
              <Field label="Admission-form fee">
                {s.admissionFormFeeMinor > 0 ? money(s.admissionFormFeeMinor) : "Free"}
              </Field>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Platform payments (latest {s.payments.length})</CardTitle></CardHeader>
          <CardContent>
            {s.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No platform-subscription payments yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Kind</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Reference</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.payments.map((pmt) => (
                      <tr key={pmt.reference} className="border-b border-border/60 last:border-0">
                        <td className="tnum py-2 pr-4">{shortDate(pmt.paidAt ?? pmt.createdAt)}</td>
                        <td className="py-2 pr-4">{pmt.kind}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={pmt.status === "PAID" ? "secondary" : "outline"}>{pmt.status}</Badge>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">{pmt.reference}</td>
                        <td className="tnum py-2 text-right">{money(pmt.amountMinor, pmt.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
