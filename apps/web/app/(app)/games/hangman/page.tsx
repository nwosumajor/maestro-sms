import type { HangmanSummaryDto, IdNameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OpenHangmanForm } from "@/components/game/OpenHangmanForm";

export const dynamic = "force-dynamic";

export default async function HangmanPage() {
  const session = await auth();
  const user = session!.user;
  const canHost = hasPermission(user.permissions, "game.hangman.host");

  const [games, classes] = await Promise.all([
    apiGet<Serialized<HangmanSummaryDto>[]>("/hangman"),
    canHost ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Hangman</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Guess the word letter by letter before the lives run out. Fewest wrong guesses wins.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open &amp; active rounds</CardTitle>
            <CardDescription>Join a hangman round your teacher is hosting for your class.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(games ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No hangman rounds right now.</p>
            ) : (
              (games ?? []).map((g) => (
                <div
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {g.className ?? "Class round"}{" "}
                      <span className="font-normal text-muted-foreground">· {g.difficulty.toLowerCase()}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{g.participantCount} playing</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={g.status === "ACTIVE" ? "default" : "secondary"}>{g.status}</Badge>
                    <Link href={`/games/hangman/${g.id}`} className={cn(buttonVariants({ size: "sm" }))}>
                      {g.isHost ? "Host" : g.joined ? "Resume" : "Join"}
                    </Link>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {canHost && <OpenHangmanForm classes={classes ?? []} />}
      </div>
    </AppShell>
  );
}
