import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "School Management System",
  description: "Multi-tenant LMS, monitoring, gradebook, and approvals for schools and families.",
};

// PUBLIC front-door homepage. No authentication.
export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="text-lg font-semibold tracking-tight">SMS</span>
        <Link href="/login" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Sign in
        </Link>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          One platform for your whole school
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
          A secure, multi-tenant school management system — learning, monitoring, gradebook, fees,
          HR and approvals. Schools join in minutes; parents find and apply to schools in one place.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/onboard"><Button size="lg">List your school</Button></Link>
          <Link href="/schools"><Button size="lg" variant="outline">Find a school</Button></Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-4xl gap-4 px-6 pb-20 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">For school leaders</CardTitle>
            <CardDescription>
              Request to onboard your school. Our team provisions your tenant and sets up your
              school administrator and principal — they then add the rest of your staff and students.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/onboard" className="text-sm font-medium text-primary hover:underline">
              Request onboarding →
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">For parents</CardTitle>
            <CardDescription>
              Browse onboarded schools, pick one or two, and submit a detailed enrolment application
              for your child. You&apos;ll be notified of the entrance-exam date once reviewed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/schools" className="text-sm font-medium text-primary hover:underline">
              Browse schools →
            </Link>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
