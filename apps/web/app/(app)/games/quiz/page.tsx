import type { IdNameDto, LiveQuizSessionSummaryDto, LiveQuizSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { QuizHostConsole } from "@/components/game/QuizHostConsole";

export const dynamic = "force-dynamic";

export default async function LiveQuizPage() {
  const session = await auth();
  const user = session!.user;
  const canHost = hasPermission(user.permissions, "game.quiz.host");

  const [sessions, quizzes, classes] = await Promise.all([
    apiGet<Serialized<LiveQuizSessionSummaryDto>[]>("/quiz-sessions"),
    canHost ? apiGet<Serialized<LiveQuizSummaryDto>[]>("/quizzes") : Promise.resolve(null),
    canHost ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Live Quiz</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Kahoot-style themed quizzes — answer correctly and fast to top the leaderboard.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live &amp; open sessions</CardTitle>
            <CardDescription>Join a quiz your teacher is hosting for your class.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(sessions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No live quizzes right now.</p>
            ) : (
              (sessions ?? []).map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {s.title}{" "}
                      <span className="font-normal text-muted-foreground">
                        · {s.theme.charAt(0) + s.theme.slice(1).toLowerCase()} · {s.difficulty.toLowerCase()}
                        {s.className ? ` · ${s.className}` : ""}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{s.participantCount} playing</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.status === "ACTIVE" ? "default" : "secondary"}>{s.status}</Badge>
                    <Link href={`/games/quiz/${s.id}`} className={cn(buttonVariants({ size: "sm" }))}>
                      {s.isHost ? "Host" : s.joined ? "Resume" : "Join"}
                    </Link>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {canHost && <QuizHostConsole quizzes={quizzes ?? []} classes={classes ?? []} />}
      </div>
    </AppShell>
  );
}
