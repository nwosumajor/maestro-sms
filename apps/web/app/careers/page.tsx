import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

type CareerSchool = { id: string; name: string; slug: string; openings: number | null };

// PUBLIC careers index. Linked from the landing page header; each school's own
// board lives at /careers/[slug].
//
// This used to list EVERY active school and invite the visitor to "view
// vacancies" at each one. Measured live, two of three schools had no open
// requisition at all, so most of those links were dead ends discoverable only
// by clicking. It now asks the API which schools are actually hiring, which is
// also one request instead of one per school the visitor tries.
//
// `reachable` distinguishes "nobody is hiring" from "we could not ask" — a
// public page that swallows an API failure tells a job seeker the platform has
// no jobs, which is a claim, not an empty state.
export default async function CareersIndexPage() {
  let schools: CareerSchool[] = [];
  let reachable = true;
  try {
    const res = await fetch(`${API_BASE}/public/careers`, { cache: "no-store" });
    if (res.ok) schools = (await res.json()) as CareerSchool[];
    else reachable = false;
  } catch {
    reachable = false;
  }

  return (
    <main className="relative mx-auto min-h-screen max-w-3xl bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <h1 className="pr-14 text-2xl font-semibold tracking-tight">Careers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Work at a school on the platform — these schools are hiring right now.
      </p>
      <div className="mt-6 space-y-3">
        {!reachable && (
          <p className="text-sm text-destructive">
            We couldn&rsquo;t load the vacancy list just now, so this isn&rsquo;t a sign that nobody is hiring.
            Please try again shortly.
          </p>
        )}
        {reachable && schools.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No school has an open position at the moment. Check back soon — new vacancies appear here as
            schools post them.
          </p>
        )}
        {schools.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle className="text-base">{s.name}</CardTitle>
              <CardDescription>
                {s.openings === null
                  ? "View this school's careers board."
                  : `${s.openings} open position${s.openings === 1 ? "" : "s"} — apply online.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={`/careers/${s.slug}`} className="text-sm font-medium underline underline-offset-2">
                View vacancies →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
