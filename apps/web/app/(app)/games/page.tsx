import type {
  CompetitionDto,
  GameSettingsDto,
  IdNameDto,
  OpenGameDto,
  RaceSummaryDto,
  Serialized,
} from "@sms/types";
import Link from "next/link";
import {
  CircleDot,
  Crosshair,
  Crown,
  Flag,
  Globe,
  Keyboard,
  Settings2,
  SpellCheck,
  Swords,
  Trophy,
  Zap,
} from "lucide-react";
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
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

/** One game in the arcade catalog. The accent is the GAME's identity (fixed
 *  across tenants, like the dead/wounded colours) — Tailwind needs literal
 *  class strings, so each game carries its own. */
function GameTile({
  icon,
  accentBar,
  accentTile,
  name,
  blurb,
  children,
}: {
  icon: React.ReactNode;
  accentBar: string;
  accentTile: string;
  name: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-elevated">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", accentBar)} />
      <div className="flex items-start gap-3">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", accentTile)}>{icon}</span>
        <div className="min-w-0">
          <p className="font-medium leading-tight">{name}</p>
          <p className="mt-1 text-xs text-muted-foreground">{blurb}</p>
        </div>
      </div>
      <div className="mt-auto pt-4">{children}</div>
    </div>
  );
}

/** Small accent icon for the functional section headers below the catalog. */
function SectionIcon({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md", className)}>{children}</span>
  );
}

export default async function GamesPage() {
  const session = await auth();
  const user = session!.user;
  const canPlay = hasPermission(user.permissions, "game.play");
  const canRaceOpen = hasPermission(user.permissions, "game.race.open");
  const canLeague = hasPermission(user.permissions, "game.league.create");
  const canSettings = hasPermission(user.permissions, "game.settings.manage");
  const canQuizHost = hasPermission(user.permissions, "game.quiz.host");
  const canHangmanHost = hasPermission(user.permissions, "game.hangman.host");
  const canTypingHost = hasPermission(user.permissions, "game.typing.host");
  const canModerate = hasPermission(user.permissions, "game.match.moderate");

  const [openGames, classes, races, competitions, people, settings] = await Promise.all([
    canPlay ? apiGet<Serialized<OpenGameDto>[]>("/games/open") : Promise.resolve(null),
    canRaceOpen ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve(null),
    apiGet<Serialized<RaceSummaryDto>[]>("/races"),
    apiGet<Serialized<CompetitionDto>[]>("/competitions"),
    canLeague ? apiGet<Serialized<IdNameDto>[]>("/students") : Promise.resolve(null),
    canSettings ? apiGet<Serialized<GameSettingsDto>>("/game-settings") : Promise.resolve(null),
  ]);

  const leagues = (competitions ?? []).filter((c) => c.type === "LEAGUE" || c.type === "KNOCKOUT");
  const cta = cn(buttonVariants({ size: "sm" }));
  const ctaOutline = cn(buttonVariants({ variant: "outline", size: "sm" }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <PageHeader title={<>Games</>} subtitle={<>Code-cracking, quizzes, and board duels — school-safe, teacher-visible, all scores on the server.</>} />
          {/* The house game's grammar, shown as a worked example. */}
          <p className="mt-2 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
            <span>
              secret <span className="tracking-[0.2em] text-foreground">0357</span>
            </span>
            <span>
              guess <span className="tracking-[0.2em] text-foreground">0753</span>
            </span>
            <span aria-hidden>→</span>
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-semibold text-destructive">2 dead</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600">2 wnd</span>
          </p>
        </div>

        {/* --- the arcade catalog ------------------------------------------- */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {canPlay && (
            <GameTile
              icon={<Swords className="h-5 w-5" aria-hidden />}
              accentBar="bg-primary"
              accentTile="bg-primary/12 text-primary"
              name="Quick duel"
              blurb="1-on-1 code-cracking. Create one and share, or join an open game below."
            >
              <StartDuelButton />
            </GameTile>
          )}
          {canPlay && (
            <GameTile
              icon={<Crosshair className="h-5 w-5" aria-hidden />}
              accentBar="bg-red-500"
              accentTile="bg-red-500/12 text-red-500"
              name="Elimination ring"
              blurb="Everyone hunts the next player's code — last one standing wins."
            >
              <StartRingButton />
            </GameTile>
          )}
          {(canPlay || canQuizHost) && (
            <GameTile
              icon={<Zap className="h-5 w-5" aria-hidden />}
              accentBar="bg-violet-500"
              accentTile="bg-violet-500/12 text-violet-500"
              name="Live Quiz"
              blurb="Kahoot-style themed rounds — answer correctly and fast to score."
            >
              <Link href="/games/quiz" className={cta}>
                {canQuizHost ? "Host or join a quiz" : "Join a live quiz"}
              </Link>
            </GameTile>
          )}
          {(canPlay || canHangmanHost) && (
            <GameTile
              icon={<SpellCheck className="h-5 w-5" aria-hidden />}
              accentBar="bg-amber-500"
              accentTile="bg-amber-500/12 text-amber-600"
              name="Hangman"
              blurb="Guess the word letter by letter before the lives run out."
            >
              <Link href="/games/hangman" className={cta}>
                {canHangmanHost ? "Host or join hangman" : "Join a hangman round"}
              </Link>
            </GameTile>
          )}
          {(canPlay || canTypingHost) && (
            <GameTile
              icon={<Keyboard className="h-5 w-5" aria-hidden />}
              accentBar="bg-sky-500"
              accentTile="bg-sky-500/12 text-sky-500"
              name="Typing Race"
              blurb="Type the passage fast and accurately — highest net WPM wins."
            >
              <Link href="/games/typing" className={cta}>
                {canTypingHost ? "Host or join a race" : "Join a typing race"}
              </Link>
            </GameTile>
          )}
          {(canPlay || canModerate) && (
            <GameTile
              icon={<CircleDot className="h-5 w-5" aria-hidden />}
              accentBar="bg-rose-600"
              accentTile="bg-rose-600/12 text-rose-600"
              name="Checkers"
              blurb="Classic 8×8 draughts — challenge a classmate to a timed duel."
            >
              <Link href="/games/checkers" className={cta}>
                {canPlay ? "Play checkers" : "View checkers games"}
              </Link>
            </GameTile>
          )}
          {(canPlay || canModerate) && (
            <GameTile
              icon={<Crown className="h-5 w-5" aria-hidden />}
              accentBar="bg-teal-600"
              accentTile="bg-teal-600/12 text-teal-600"
              name="Chess"
              blurb="Full-rules chess — castling, en passant, promotion, and the clock."
            >
              <Link href="/games/chess" className={cta}>
                {canPlay ? "Play chess" : "View chess games"}
              </Link>
            </GameTile>
          )}
        </div>

        {/* --- live now / competitions --------------------------------------- */}
        {canPlay && openGames && openGames.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <SectionIcon className="bg-primary/12 text-primary">
                <Swords className="h-4 w-4" aria-hidden />
              </SectionIcon>
              <div>
                <CardTitle className="text-base">Open duels</CardTitle>
                <CardDescription>Waiting for an opponent — jump in.</CardDescription>
              </div>
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
                    <Link href={`/games/duel/${g.id}`} className={ctaOutline}>
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
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <SectionIcon className="bg-brand2/12 text-brand2">
                <Flag className="h-4 w-4" aria-hidden />
              </SectionIcon>
              <div>
                <CardTitle className="text-base">Class races</CardTitle>
                <CardDescription>
                  {canRaceOpen
                    ? "Open a race for one of your classes, or jump into a live one."
                    : "Races you can join — first three to crack the code win."}
                </CardDescription>
              </div>
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
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <SectionIcon className="bg-amber-500/12 text-amber-600">
              <Trophy className="h-4 w-4" aria-hidden />
            </SectionIcon>
            <div>
              <CardTitle className="text-base">Leagues &amp; knockouts</CardTitle>
              <CardDescription>School competitions — standings and brackets.</CardDescription>
            </div>
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
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <SectionIcon className="bg-indigo-500/12 text-indigo-400">
              <Globe className="h-4 w-4" aria-hidden />
            </SectionIcon>
            <div>
              <CardTitle className="text-base">Ultimate (cross-school)</CardTitle>
              <CardDescription>Compete against other schools under a handle. Consent required.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Link href="/games/ultimate" className={cn(buttonVariants({ variant: "outline" }))}>
              Open Ultimate
            </Link>
          </CardContent>
        </Card>

        {canSettings && settings && (
          <Card>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <SectionIcon className="bg-muted text-muted-foreground">
                <Settings2 className="h-4 w-4" aria-hidden />
              </SectionIcon>
              <div>
                <CardTitle className="text-base">Game settings</CardTitle>
                <CardDescription>School-wide configuration for all game modes.</CardDescription>
              </div>
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
