import type { Serialized, UltimateCompetitionDto } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateUltimateForm } from "@/components/game/UltimateAdmin";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function UltimateListPage() {
  const session = await auth();
  const user = session!.user;
  // The Games section is gated on game.leaderboard.read — the same permission
  // the AppShell nav uses. Without this the nav merely HID the link: all 18
  // pages stayed reachable by URL and fetched anyway, so the 14 roles that
  // hold no game permission generated ~200 refused API calls per pass.
  if (!hasPermission(user.permissions, "game.leaderboard.read")) redirect("/dashboard");
  const canAdmin = hasPermission(user.permissions, "game.ultimate.admin");
  const comps = (await apiGet<Serialized<UltimateCompetitionDto>[]>("/ultimate/competitions")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="ultimate" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link></>} title={<>Ultimate · cross-school</>} subtitle={<>Play other schools under a handle — never your real name. Requires your school to opt in and a guardian
            consent flag on file.</>} />

        {canAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create a competition</CardTitle>
              <CardDescription>Super-admin only. Spans all enrolled schools.</CardDescription>
            </CardHeader>
            <CardContent>
              <CreateUltimateForm />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Competitions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {comps.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">No competitions yet.</p>
            ) : (
              <ul>
                {comps.map((c) => (
                  <li key={c.id} className="border-b border-border last:border-0">
                    <Link href={`/games/ultimate/${c.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-accent">
                      <span className="text-sm">
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-muted-foreground">· {c.difficultyLength} digits</span>
                        {c.entered && <span className="ml-2 text-xs text-primary">entered</span>}
                        {!c.entered && c.schoolEnrolled && <span className="ml-2 text-xs text-muted-foreground">enrolled</span>}
                      </span>
                      <Badge variant={c.status === "ACTIVE" ? "default" : "secondary"}>{c.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
