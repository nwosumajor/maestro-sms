import type { CheckersSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewCheckersButton } from "@/components/game/NewCheckersButton";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function CheckersPage() {
  const session = await auth();
  const user = session!.user;
  const games = await apiGet<Serialized<CheckersSummaryDto>[]>("/checkers");

  const open = (games ?? []).filter((g) => g.status === "LOBBY" && !g.yourColor);
  const mine = (games ?? []).filter((g) => g.yourColor);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link></>} title={<>Checkers</>} subtitle={<>Classic 8×8 draughts. Create a game and share it, or join an open one below.</>} />

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Start a game</CardTitle>
            <NewCheckersButton />
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open games to join</CardTitle>
            <CardDescription>Games waiting for a second player.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {open.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open games right now — create one above.</p>
            ) : (
              open.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                  <span className="text-sm">
                    <span className="font-medium">{g.blackName}</span>{" "}
                    <span className="text-muted-foreground">is waiting</span>
                  </span>
                  <Link href={`/games/checkers/${g.id}`} className={cn(buttonVariants({ size: "sm" }))}>
                    Join
                  </Link>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {mine.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your games</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {mine.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                  <span className="text-sm">
                    vs <span className="font-medium">{g.yourColor === "b" ? g.whiteName ?? "waiting…" : g.blackName}</span>
                    {g.isYourTurn && <span className="ml-2 text-xs font-medium text-primary">your turn</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant={g.status === "ACTIVE" ? "default" : "secondary"}>{g.status}</Badge>
                    <Link href={`/games/checkers/${g.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      Open
                    </Link>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
