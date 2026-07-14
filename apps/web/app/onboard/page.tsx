import Link from "next/link";
import { OnboardForm } from "@/components/public/OnboardForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective principal requests to onboard.
// The comprehensive intake (school profile, location, size, contact, plan) lives
// here on its own page; the homepage links to it.
export default function OnboardPage() {
  return (
    <main className="force-light min-h-screen bg-background p-6">
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
            <OnboardForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
