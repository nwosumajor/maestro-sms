import type { ChessGameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ChessPlay } from "@/components/game/ChessPlay";

export const dynamic = "force-dynamic";

export default async function ChessGamePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const game = await apiGet<Serialized<ChessGameDto>>(`/chess/${params.id}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games/chess" className="text-sm text-muted-foreground hover:text-foreground">
            ← Chess
          </Link>
        </div>
        {game ? (
          <ChessPlay initial={game} />
        ) : (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This game doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
