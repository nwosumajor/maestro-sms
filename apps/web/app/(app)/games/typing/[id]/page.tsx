import type { Serialized, TypingRaceDto } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TypingPlay } from "@/components/game/TypingPlay";

export const dynamic = "force-dynamic";

export default async function TypingRaceRoundPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const race = await apiGet<Serialized<TypingRaceDto>>(`/typing-races/${params.id}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games/typing" className="text-sm text-muted-foreground hover:text-foreground">
            ← Typing Race
          </Link>
        </div>
        {race ? (
          <TypingPlay initial={race} />
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
