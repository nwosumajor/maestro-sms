import type {
  IdNameDto,
  Serialized,
  UltimateCompetitionDto,
  UltimateEntryDto,
  UltimateLeaderboardDto,
} from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UltimatePlay } from "@/components/game/UltimatePlay";
import { ConsentForm, EnrollSchoolButton } from "@/components/game/UltimateAdmin";

export const dynamic = "force-dynamic";

export default async function UltimateDetailPage({ params }: { params: { id: string } }) {
  const session = await auth();
  const user = session!.user;
  const canEnter = hasPermission(user.permissions, "game.play");
  const canEnroll = hasPermission(user.permissions, "game.ultimate.enroll");
  const canConsent = hasPermission(user.permissions, "game.ultimate.consent");

  const [comps, board, entry, students] = await Promise.all([
    apiGet<Serialized<UltimateCompetitionDto>[]>("/ultimate/competitions"),
    apiGet<Serialized<UltimateLeaderboardDto>>(`/ultimate/competitions/${params.id}/leaderboard`),
    apiGet<Serialized<UltimateEntryDto>>(`/ultimate/competitions/${params.id}/me`),
    canConsent ? apiGet<Serialized<IdNameDto>[]>("/students") : Promise.resolve(null),
  ]);
  const comp = (comps ?? []).find((c) => c.id === params.id) ?? null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="games" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/games/ultimate" className="text-sm text-muted-foreground hover:text-foreground">
            ← Ultimate
          </Link>
        </div>

        {!comp || !board ? (
          <Alert variant="info">
            <AlertTitle>Not found</AlertTitle>
            <AlertDescription>This competition doesn&apos;t exist or you can&apos;t access it.</AlertDescription>
          </Alert>
        ) : (
          <>
            {(canEnroll || canConsent) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">School administration</CardTitle>
                  <CardDescription>Opt your school in, then record per-student guardian consent.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {canEnroll && <EnrollSchoolButton competitionId={comp.id} enrolled={comp.schoolEnrolled} />}
                  {canConsent && students && (
                    <div className="border-t border-border pt-4">
                      <p className="mb-3 text-sm font-medium">Guardian consent</p>
                      <ConsentForm students={students} />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <UltimatePlay comp={comp} initialEntry={entry} initialBoard={board} canEnter={canEnter} />
          </>
        )}
      </div>
    </AppShell>
  );
}
