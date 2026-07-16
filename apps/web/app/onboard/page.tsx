import Link from "next/link";
import { OnboardForm } from "@/components/public/OnboardForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective principal requests to onboard.
// The comprehensive intake (school profile, location, size, contact, plan) lives
// here on its own page; the homepage links to it. `?ref=CODE` (a referring
// school's share link) prefills the referral-code field.
export default function OnboardPage({ searchParams }: { searchParams: { ref?: string } }) {
  const ref = (searchParams.ref ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40);
  return (
    <main className="relative min-h-screen bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <div className="mx-auto max-w-3xl py-8">
        <Card>
          <CardHeader>
            <CardTitle>List your school on SMS</CardTitle>
            <CardDescription>
              Tell us about your school — it takes about five minutes. Our platform team reviews each
              request and provisions your tenant with a school administrator and a principal account; they
              then add the rest of your staff and students.{" "}
              <Link href="/" className="text-primary hover:underline">← Back home</Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OnboardForm defaultReferralCode={ref} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
