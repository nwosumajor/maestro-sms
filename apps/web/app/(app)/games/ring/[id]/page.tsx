import type { RingDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RingPlay } from "@/components/game/RingPlay";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function RingPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const ring = await apiGet<Serialized<RingDto>>(`/rings/${params.id}`);
  const canModerate = hasPermission(user.permissions, "game.match.moderate");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/games" className="text-sm text-muted-foreground hover:text-foreground">
            ← Games
          </Link></>} title={<>Elimination Ring</>} />
        {ring ? (
          <RingPlay initial={ring} canModerate={canModerate} />
        ) : (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This ring doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
