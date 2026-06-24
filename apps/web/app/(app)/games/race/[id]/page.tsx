import type { RaceDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RacePlay } from "@/components/game/RacePlay";

export const dynamic = "force-dynamic";

export default async function RacePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const race = await apiGet<Serialized<RaceDto>>(`/races/${params.id}`);
  const canOpen = hasPermission(user.permissions, "game.race.open");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Class Race</h1>
        </div>
        {race ? (
          <RacePlay initial={race} canOpen={canOpen} />
        ) : (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This race doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
