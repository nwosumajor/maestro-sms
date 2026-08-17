// The cover duties assigned TO ME.
//
// Assigning a reliever already notifies them — "you are covering 2B Chemistry on
// Tuesday" — and that notification was the only place the duty existed. The
// endpoint behind this list (`GET /timetable/cover/mine`, self-scoped, any
// teacher) was built and never called by anything, so a teacher who dismissed
// the notification had no way back to it, and no way to see next week's.
//
// Deliberately NOT gated on timetable.write: that permission is for the person
// who ASSIGNS cover. The whole point is the teacher receiving it, who does not
// have it.

import type { MyCoverDutyDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Duty = Serialized<MyCoverDutyDto>;

/**
 * A SERVER component. It only displays, so being a client island bought nothing
 * and cost a round trip after hydration.
 *
 * // GOTCHA: it also used to date its own request — `new Date().toISOString()`,
 * the UTC day on the USER's clock. "Today" is the school's calendar day here as
 * everywhere else, and west of UTC the browser's UTC day is already tomorrow
 * for the last hours of every evening: a teacher in Toronto at 20:00 on Monday
 * asked for Tuesday onward and could not see the duty they were about to cover.
 * The window is now the server's to decide, in the school's timezone.
 *
 * `duties === null` means the read did not happen. Said plainly rather than
 * rendered as an empty list, because "you have nothing to cover" is exactly the
 * wrong thing to tell someone who does.
 */
export function MyCoverDuties({ duties }: { duties: Duty[] | null }) {
  const msg = duties === null ? "Couldn't load your cover duties." : null;

  // Nothing to cover is the normal case — don't take up the page saying so.
  if (duties !== null && duties.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Your cover duties</CardTitle>
        <CardDescription>Lessons you have been asked to cover over the next four weeks.</CardDescription>
      </CardHeader>
      <CardContent>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        {duties && duties.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Date</th>
                  <th className="py-1 pr-3 font-medium">Period</th>
                  <th className="py-1 pr-3 font-medium">Class</th>
                  <th className="py-1 pr-3 font-medium">Subject</th>
                  <th className="py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {duties.map((d) => (
                  <tr key={d.coverId} className="border-b border-border/50">
                    <td className="py-1 pr-3 whitespace-nowrap">{d.date}</td>
                    <td className="py-1 pr-3">{d.periodName}</td>
                    <td className="py-1 pr-3">{d.className}</td>
                    <td className="py-1 pr-3">{d.subject}</td>
                    <td className="py-1 text-muted-foreground">{d.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
