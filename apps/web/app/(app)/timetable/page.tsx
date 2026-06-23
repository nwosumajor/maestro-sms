import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { TimetableAdmin } from "@/components/timetable/TimetableAdmin";

export const dynamic = "force-dynamic";

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;

interface Period { id: string; name: string; sequence: number; startTime: string; endTime: string }
interface ClassRow { id: string; name: string }
interface Room { id: string; name: string }
interface Entry {
  id: string;
  dayOfWeek: string;
  periodId: string;
  subject: string;
  room: { name: string } | null;
}

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: { classId?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const canWrite = user.permissions.includes("timetable.write");
  const [periods, classes, rooms] = await Promise.all([
    apiGet<Period[]>("/timetable/periods"),
    apiGet<ClassRow[]>("/classes/mine"),
    canWrite ? apiGet<Room[]>("/timetable/rooms") : Promise.resolve(null),
  ]);

  const list = classes ?? [];
  const selectedId = searchParams.classId ?? list[0]?.id;
  const entries = selectedId ? await apiGet<Entry[]>(`/timetable/classes/${selectedId}`) : [];
  const cell = (periodId: string, day: string) =>
    (entries ?? []).find((e) => e.periodId === periodId && e.dayOfWeek === day);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="timetable" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Timetable</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The weekly lesson grid. Conflicts (a teacher, room, or class booked
            twice in one slot) are prevented when entries are created.
          </p>
        </div>

        {canWrite && (
          <TimetableAdmin classes={list} periods={periods ?? []} rooms={rooms ?? []} />
        )}

        {list.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes</AlertTitle>
            <AlertDescription>You are not linked to any classes.</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {list.map((c) => (
                <Link
                  key={c.id}
                  href={`/timetable?classId=${c.id}`}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    c.id === selectedId
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {c.name}
                </Link>
              ))}
            </div>

            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2.5 font-medium">Period</th>
                      {DAYS.map((d) => (
                        <th key={d} className="px-3 py-2.5 font-medium capitalize">{d.toLowerCase()}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(periods ?? []).map((p) => (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-3 py-2.5 align-top">
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.startTime}–{p.endTime}</div>
                        </td>
                        {DAYS.map((d) => {
                          const e = cell(p.id, d);
                          return (
                            <td key={d} className="px-3 py-2.5 align-top">
                              {e ? (
                                <div className="rounded-md bg-primary/[0.06] px-2 py-1.5">
                                  <div className="font-medium">{e.subject}</div>
                                  {e.room && <div className="text-xs text-muted-foreground">{e.room.name}</div>}
                                </div>
                              ) : (
                                <span className="text-muted-foreground/40">·</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {(periods ?? []).length === 0 && (
                      <tr>
                        <td colSpan={DAYS.length + 1} className="px-3 py-4 text-muted-foreground">
                          No periods defined yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
