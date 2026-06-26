import type { CompetitionDetailDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LeagueView } from "@/components/game/LeagueView";

export const dynamic = "force-dynamic";

export default async function LeaguePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const comp = await apiGet<Serialized<CompetitionDetailDto>>(`/competitions/${params.id}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{comp?.name ?? "Competition"}</h1>
          {comp && (
            <p className="mt-1 text-sm text-muted-foreground">
              {comp.type === "KNOCKOUT" ? "Knockout" : "League"} · {comp.difficultyLength} digits ·{" "}
              {comp.participantCount} players · round {comp.currentRound}
            </p>
          )}
        </div>

        {!comp ? (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This competition doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        ) : (
          // Live standings/matches over /ws/watch (mode "league"); REST poll fallback.
          <LeagueView initial={comp} />
        )}
      </div>
    </AppShell>
  );
}
