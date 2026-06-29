import Link from "next/link";
import { OnboardForm } from "@/components/public/OnboardForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective principal requests to onboard.
export default function OnboardPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>List your school on SMS</CardTitle>
          <CardDescription>
            Tell us about your school. Our platform team reviews each request and provisions your tenant
            with a school administrator and a principal account — they then add the rest of your staff and
            students. <Link href="/" className="text-primary hover:underline">← Back home</Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardForm />
        </CardContent>
      </Card>
    </main>
  );
}
