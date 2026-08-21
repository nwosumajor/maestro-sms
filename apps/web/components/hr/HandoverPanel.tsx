import type { Serialized, StaffHandoverDto } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * What this member of staff would leave behind.
 *
 * Server-rendered and read-only: it reassigns nothing, and says so. The
 * platform cannot know who should take a class, and a button that moved thirty
 * assignments to a name it picked would be a worse failure than the silence it
 * replaces.
 *
 * DATED duties are called out separately because they are a different problem:
 * a class list needs tidying, but a cover lesson next Tuesday and an exam to
 * invigilate need somebody standing in a room.
 */
export function HandoverPanel({ handover }: { handover: Serialized<StaffHandoverDto> | null }) {
  if (!handover) return null;
  const dated = handover.duties.filter((d) => d.dated);
  const datedTotal = dated.reduce((n, d) => n + d.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Duties held</CardTitle>
        <CardDescription>
          {handover.total === 0 ? (
            <>Nothing is currently assigned to them, so an exit would leave no work behind.</>
          ) : (
            <>
              {handover.total} {handover.total === 1 ? "duty" : "duties"} are assigned to them today.
              Nothing here is reassigned automatically — this is the list to work through before a
              last working day.
            </>
          )}
        </CardDescription>
      </CardHeader>
      {handover.total > 0 && (
        <CardContent className="space-y-3">
          {datedTotal > 0 && (
            <p className="text-sm text-destructive">
              {datedTotal} of these fall on a date — somebody has to be there for them.
            </p>
          )}
          <ul className="space-y-2">
            {handover.duties.map((d) => (
              <li key={d.kind} className="flex items-start justify-between gap-4 border-b border-border/60 pb-2 last:border-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{d.label}</span>
                    {d.dated && <Badge variant="destructive">Dated</Badge>}
                  </div>
                  {d.detail.length > 0 && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {d.detail.join(" · ")}
                      {d.count > d.detail.length ? ` … and ${d.count - d.detail.length} more` : ""}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-sm tabular-nums">{d.count}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
