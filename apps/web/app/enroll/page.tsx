import Link from "next/link";
import type { PublicSchoolDto } from "@sms/types";
import { EnrollForm } from "@/components/public/EnrollForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

async function getSchools(): Promise<PublicSchoolDto[]> {
  try {
    const res = await fetch(`${API_BASE}/public/schools`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as PublicSchoolDto[];
  } catch {
    return [];
  }
}

// PUBLIC page — no authentication. A parent applies to enrol their child.
export default async function EnrollPage({ searchParams }: { searchParams: { school?: string } }) {
  const schools = await getSchools();

  return (
    <main className="relative mx-auto min-h-screen max-w-2xl bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <header className="flex items-center justify-between py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">SMS</Link>
        <Link href="/schools" className="text-sm text-muted-foreground hover:text-foreground">All schools</Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Apply for enrolment</CardTitle>
          <CardDescription>
            Select up to two schools and submit one application for your child. Each school reviews it
            (admissions → HR → principal) and emails you the entrance-exam date once decided. Your details are
            kept separate from enrolled-student records until accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {schools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No schools are available right now. Please check back soon.</p>
          ) : (
            <EnrollForm schools={schools} preselect={searchParams.school} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
