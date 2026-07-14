import type { IdNameDto, Serialized, TypingRaceSummaryDto } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OpenTypingForm } from "@/components/game/OpenTypingForm";

export const dynamic = "force-dynamic";

export default async function TypingRacePage() {
  const session = await auth();
  const user = session!.user;
  const canHost = hasPermission(user.permissions, "game.typing.host");

  const [races, classes] = await Promise.all([
    apiGet<Serialized<TypingRaceSummaryDto>[]>("/typing-races"),
    canHost ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Typing Race</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Type the passage as fast and accurately as you can — highest net WPM wins.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open &amp; active races</CardTitle>
            <CardDescription>Join a typing race your teacher is hosting for your class.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(races ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No typing races right now.</p>
            ) : (
              (races ?? []).map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {r.className ?? "Class race"}{" "}
                      <span className="font-normal text-muted-foreground">· {r.difficulty.toLowerCase()}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{r.participantCount} racing</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === "ACTIVE" ? "default" : "secondary"}>{r.status}</Badge>
                    <Link href={`/games/typing/${r.id}`} className={cn(buttonVariants({ size: "sm" }))}>
                      {r.isHost ? "Host" : r.joined ? "Resume" : "Join"}
                    </Link>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {canHost && <OpenTypingForm classes={classes ?? []} />}
      </div>
    </AppShell>
  );
}
