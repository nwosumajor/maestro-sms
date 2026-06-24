import type {
  CompetitionDto,
  GameSettingsDto,
  IdNameDto,
  OpenGameDto,
  RaceSummaryDto,
  Serialized,
} from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StartDuelButton, StartRingButton } from "@/components/game/HubActions";
import { OpenRaceForm } from "@/components/game/OpenRaceForm";
import { CreateLeagueForm } from "@/components/game/CreateLeagueForm";
import { GameSettingsForm } from "@/components/game/GameSettingsForm";

export const dynamic = "force-dynamic";

export default async function GamesPage() {
  const session = await auth();
  const user = session!.user;
  const canPlay = hasPermission(user.permissions, "game.play");
  const canRaceOpen = hasPermission(user.permissions, "game.race.open");
  const canLeague = hasPermission(user.permissions, "game.league.create");
  const canSettings = hasPermission(user.permissions, "game.settings.manage");

  const [openGames, classes, races, competitions, people, settings] = await Promise.all([
    canPlay ? apiGet<Serialized<OpenGameDto>[]>("/games/open") : Promise.resolve(null),
    canRaceOpen ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve(null),
    apiGet<Serialized<RaceSummaryDto>[]>("/races"),
    apiGet<Serialized<CompetitionDto>[]>("/competitions"),
    canLeague ? apiGet<Serialized<IdNameDto>[]>("/students") : Promise.resolve(null),
    canSettings ? apiGet<Serialized<GameSettingsDto>>("/game-settings") : Promise.resolve(null),
  ]);

  const leagues = (competitions ?? []).filter((c) => c.type === "LEAGUE" || c.type === "KNOCKOUT");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dead &amp; Wounded</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Crack the secret code. <span className="font-semibold text-destructive">Dead</span> = right digit in the
            right place; <span className="font-semibold text-amber-600">wounded</span> = right digit, wrong place.
          </p>
        </div>

        {canPlay && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick duel</CardTitle>
                <CardDescription>1-on-1. Create one and share, or join an open game below.</CardDescription>
              </CardHeader>
              <CardContent>
                <StartDuelButton />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Elimination ring</CardTitle>
                <CardDescription>Everyone vs everyone — last one standing wins.</CardDescription>
              </CardHeader>
              <CardContent>
                <StartRingButton />
              </CardContent>
            </Card>
          </div>
        )}

        {canPlay && openGames && openGames.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Open duels</CardTitle>
              <CardDescription>Waiting for an opponent — jump in.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ul>
                {openGames.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between border-b border-border px-4 py-2.5 last:border-0"
                  >
                    <span className="text-sm">
                      <span className="font-medium">{g.hostDisplayName}</span>{" "}
                      <span className="text-muted-foreground">· {g.difficultyLength} digits</span>
                    </span>
                    <Link href={`/games/duel/${g.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      Join
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {(canRaceOpen || (races && races.length > 0)) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Class races</CardTitle>
              <CardDescription>
                {canRaceOpen
                  ? "Open a race for one of your classes, or jump into a live one."
                  : "Races you can join — first three to crack the code win."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {races && races.length > 0 ? (
                <ul className="space-y-1.5">
                  {races.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/games/race/${r.id}`}
                        className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
                      >
                        <span>
                          <span className="font-medium">{r.className ?? "Race"}</span>{" "}
                          <span className="text-muted-foreground">
                            · {r.difficultyLength} digits · {r.participantCount} racing
                          </span>
                          {r.joined && <span className="ml-2 text-xs text-primary">joined</span>}
                        </span>
                        <Badge variant={r.status === "ACTIVE" ? "default" : "secondary"}>{r.status}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No open races right now.</p>
              )}
              {canRaceOpen && classes && (
                <div className="border-t border-border pt-4">
                  <p className="mb-3 text-sm font-medium">Open a race</p>
                  <OpenRaceForm classes={classes} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leagues &amp; knockouts</CardTitle>
            <CardDescription>School competitions — standings and brackets.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {leagues.length === 0 ? (
              <p className="text-sm text-muted-foreground">No competitions yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {leagues.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/games/league/${c.id}`}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
                    >
                      <span className="font-medium">
                        {c.name} <span className="text-muted-foreground">· {c.type === "KNOCKOUT" ? "Knockout" : "League"}</span>
                      </span>
                      <Badge variant={c.status === "ACTIVE" ? "default" : "secondary"}>{c.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {canLeague && people && (
              <div className="border-t border-border pt-4">
                <p className="mb-3 text-sm font-medium">Create a competition</p>
                <CreateLeagueForm people={people} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ultimate (cross-school)</CardTitle>
            <CardDescription>Compete against other schools under a handle. Consent required.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/games/ultimate" className={cn(buttonVariants({ variant: "outline" }))}>
              Open Ultimate
            </Link>
          </CardContent>
        </Card>

        {canSettings && settings && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Game settings</CardTitle>
              <CardDescription>School-wide configuration for all game modes.</CardDescription>
            </CardHeader>
            <CardContent>
              <GameSettingsForm initial={settings} />
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
