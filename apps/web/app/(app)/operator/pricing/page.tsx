// Pricing & growth — everything that sets what the platform CHARGES and what it
// pays out to win business. Moved off the /operator hub to its own page.
//
// The three controls here belong together and belong away from the hub:
//
//   • They are one job. Plan prices, the fee-collection take rate, and promo/agent
//     commission are a single commercial policy — you change a price with the
//     discount you are offering in view, not on a different screen. Splitting them
//     across a page that is also about provisioning made that impossible to see.
//   • They are RARE. Pricing is revisited monthly at most; the hub is opened daily
//     for provisioning and onboarding. The hub was paying for five API calls and
//     three heavy editors on every visit for controls almost nobody had come to use.
//   • They are the highest-consequence settings in the product. A mistyped plan
//     price reaches every quote, checkout and the public landing page; a mistyped
//     take rate silently changes what every school nets on every fee collected.
//     Controls with that blast radius deserve a screen you arrive at deliberately.
//
// All three are gated platform.pricing.manage — the SAME permission — so the page
// is either wholly available or not shown at all. That is why they group cleanly:
// a page whose sections have different permissions is a page half its viewers see
// as broken.

import type { PlanPriceDto, PlatformFeeConfig } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { PricingManager } from "@/components/operator/PricingManager";
import { PlatformFeeManager } from "@/components/operator/PlatformFeeManager";
import { GrowthManager } from "@/components/operator/GrowthManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { PaymentChannels } from "@/components/operator/PaymentChannels";

export const dynamic = "force-dynamic";

export default async function OperatorPricingPage() {
  const session = await auth();
  const user = session!.user;
  // Not merely a hidden nav item: a manager_admin who types the URL lands back on
  // the console rather than on a page of controls the API will refuse.
  if (!hasPermission(user.permissions, "platform.pricing.manage")) redirect("/operator");

  const [pricing, platformFees, channels, promos, agents, commissions] = await Promise.all([
    apiGet<PlanPriceDto[]>("/operator/pricing"),
    apiGet<PlatformFeeConfig>("/operator/platform-fees"),
    apiGet<{ enabled: string[]; all: string[]; labels: Record<string, { name: string; comingSoon: string }>; stranded: { id: string; name: string; currency: string }[]; readiness: { channel: string; enabled: boolean; configured: boolean; missing: string | null }[] }>("/operator/payment-channels"),
    // Growth reads need the privileged database; a 503 there must not blank the
    // pricing editors beside them, so each falls back to empty independently.
    apiGet<never[]>("/operator/promos").then((r) => r ?? []),
    apiGet<never[]>("/operator/agents").then((r) => r ?? []),
    apiGet<never[]>("/operator/commissions").then((r) => r ?? []),
  ]);

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="operatorpricing"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Pricing &amp; growth</>}
            subtitle={
              <>
                What the platform charges, and what it gives away to win business. Plan prices feed
                every quote, checkout and the public landing page; the take rate decides what each
                school nets on every fee it collects; promos and agent commission are what you spend
                to acquire. Changes here are audited and step-up gated.
              </>
            }
          />
          <Link href="/operator" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Operator console
          </Link>
        </div>

        {pricing === null ? (
          <Alert variant="info">
            <AlertTitle>Pricing unavailable</AlertTitle>
            <AlertDescription>
              Plan pricing could not be read. It is shown as unavailable rather than as defaults —
              editing a price you are not actually looking at is how a wrong number reaches every
              quote in the product.
            </AlertDescription>
          </Alert>
        ) : (
          <PricingManager initial={pricing} />
        )}

        {platformFees && <PlatformFeeManager initial={platformFees} />}

        {/* Which rails the platform will charge on at all — above the take-rate,
            because it decides whether there is anything to take a rate FROM. */}
        {channels && (
          <PaymentChannels
            initialEnabled={channels.enabled}
            all={channels.all}
            labels={channels.labels}
            initialStranded={channels.stranded}
            readiness={channels.readiness ?? []}
          />
        )}

        <GrowthManager promos={promos} agents={agents} commissions={commissions} />
      </div>
    </AppShell>
  );
}
