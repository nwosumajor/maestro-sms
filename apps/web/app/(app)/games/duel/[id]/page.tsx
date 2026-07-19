import type { GameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DuelPlay } from "@/components/game/DuelPlay";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function DuelPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const game = await apiGet<Serialized<GameDto>>(`/games/${params.id}`);
  const canPlay = hasPermission(user.permissions, "game.play");
  const canModerate = hasPermission(user.permissions, "game.match.moderate");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link></>} title={<>Duel</>} />
        {game ? (
          <DuelPlay initial={game} canPlay={canPlay} canModerate={canModerate} />
        ) : (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This duel doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
