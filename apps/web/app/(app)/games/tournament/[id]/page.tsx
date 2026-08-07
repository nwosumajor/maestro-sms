import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { IdNameDto, RaceTournamentDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { buttonVariants } from "@/components/ui/button";
import { TournamentView } from "@/components/game/TournamentView";

export const dynamic = "force-dynamic";

// The cross-class tournament board. The mode was fully built in the API and had
// no screen at either end — this is the read half.

export default async function TournamentPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  // The Games section is gated on game.leaderboard.read — the same permission
  // the AppShell nav uses. Without this the nav merely HID the link: all 18
  // pages stayed reachable by URL and fetched anyway, so the 14 roles that
  // hold no game permission generated ~200 refused API calls per pass.
  if (!hasPermission(user.permissions, "game.leaderboard.read")) redirect("/dashboard");
  if (!hasPermission(user.permissions, "game.leaderboard.read")) redirect("/games");

  const t = await apiGet<Serialized<RaceTournamentDto>>(`/race-tournaments/${params.id}`);
  if (!t) notFound();

  // Class names for the per-class boards. Best-effort: a missing name renders as
  // "Class" rather than blocking the board a hall is watching.
  const classes = (await apiGet<Serialized<IdNameDto>[]>("/classes/mine")) ?? [];
  const classNames = Object.fromEntries(classes.map((c) => [c.id, c.name]));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Race tournament</>}
            subtitle={<>Every class races its own secret number. Fewest guesses wins; time only breaks a tie.</>}
          />
          <Link href="/games" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Games
          </Link>
        </div>
        <TournamentView initial={t} classNames={classNames} />
      </div>
    </AppShell>
  );
}
