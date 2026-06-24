import type { CompetitionDetailDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Standings</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2 font-medium">#</th>
                      <th className="px-4 py-2 font-medium">Player</th>
                      <th className="px-4 py-2 font-medium text-right">Pts</th>
                      <th className="px-4 py-2 font-medium text-right">W–L</th>
                      <th className="px-4 py-2 font-medium text-right">Guesses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comp.standings.map((s) => (
                      <tr key={s.userId} className={cn("border-b border-border last:border-0", s.eliminated && "opacity-50")}>
                        <td className="px-4 py-2.5 text-muted-foreground">{s.rank ?? "—"}</td>
                        <td className="px-4 py-2.5 font-medium">
                          {s.displayName}
                          {s.eliminated && <span className="ml-2 text-xs text-destructive">out</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold">{s.points}</td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground">
                          {s.wins}–{s.losses}
                        </td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground">{s.totalGuesses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Matches</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {comp.matches.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">No matches scheduled.</p>
                ) : (
                  <ul>
                    {comp.matches.map((m) => {
                      const [a, b] = m.players;
                      return (
                        <li
                          key={m.gameId}
                          className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-0"
                        >
                          <span className="text-sm">
                            {m.roundNumber != null && (
                              <span className="mr-2 text-xs text-muted-foreground">R{m.roundNumber}</span>
                            )}
                            <span className={cn(m.winnerUserId === a?.userId && "font-semibold")}>
                              {a?.displayName ?? "—"}
                            </span>{" "}
                            <span className="text-muted-foreground">vs</span>{" "}
                            <span className={cn(m.winnerUserId === b?.userId && "font-semibold")}>
                              {b?.displayName ?? "(bye)"}
                            </span>
                          </span>
                          <div className="flex items-center gap-2">
                            <Badge variant={m.status === "FINISHED" ? "secondary" : m.status === "ACTIVE" ? "default" : "outline"}>
                              {m.status}
                            </Badge>
                            <Link
                              href={`/games/duel/${m.gameId}`}
                              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                            >
                              Open
                            </Link>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
