import Link from "next/link";
import { OnboardForm } from "@/components/public/OnboardForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective principal requests to onboard.
// The comprehensive intake (school profile, location, size, contact, plan) lives
// here on its own page; the homepage links to it.
//
// TWO CODES RIDE THE LINK, and they are different things. `?ref=CODE` is a
// referring SCHOOL's share link and earns both schools a free term. `?agent=`
// is a commissioned partner's link — the attribution the agent programme pays
// on. The API has always accepted `agentCode`, stored it on the request and
// resolved it at provisioning; no page ever sent one, so an agent could sign a
// school up and be credited with nothing.
//
// It arrives by LINK because that is how it will actually arrive: an agent
// hands a prospect a URL, and nobody types a code reliably. The field is still
// shown and editable so a code given verbally is not lost.
export default function OnboardPage({ searchParams }: { searchParams: { ref?: string; agent?: string } }) {
  const clean = (v: string | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40);
  const ref = clean(searchParams.ref);
  const agent = clean(searchParams.agent);
  return (
    <main className="relative min-h-screen bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <div className="mx-auto max-w-3xl py-8">
        <Card>
          <CardHeader>
            <CardTitle>List your school on MAESTRO-SMS</CardTitle>
            <CardDescription>
              Tell us about your school — it takes about five minutes. Our platform team reviews each
              request and provisions your tenant with a school administrator and a principal account; they
              then add the rest of your staff and students.{" "}
              <Link href="/" className="text-primary hover:underline">← Back home</Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OnboardForm defaultReferralCode={ref} defaultAgentCode={agent} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
