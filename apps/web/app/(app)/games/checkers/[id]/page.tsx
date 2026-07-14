import type { CheckersGameDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckersPlay } from "@/components/game/CheckersPlay";

export const dynamic = "force-dynamic";

export default async function CheckersGamePage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const game = await apiGet<Serialized<CheckersGameDto>>(`/checkers/${params.id}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games/checkers" className="text-sm text-muted-foreground hover:text-foreground">
            ← Checkers
          </Link>
        </div>
        {game ? (
          <CheckersPlay initial={game} />
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
