import type { PublishedScholarshipResultsDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Published = Serialized<PublishedScholarshipResultsDto>;

/**
 * Scholarship results, as every school on the platform reads them.
 *
 * SCHOOL, POSITION and SCORE — and no pupil is named. That is the platform
 * owner's explicit decision and it is the right one: this is a cross-school
 * table read by every tenant, and naming a minor in it is a disclosure the
 * family never asked for. The school is an institution and is named; the child
 * is not.
 *
 * The card SAYS that, rather than leaving a reader to notice the absence. A
 * table of scores with no names invites the question "whose?", and the answer
 * should be on the page rather than in a policy nobody reads.
 */
export function PublishedResults({ published }: { published: Published[] }) {
  if (published.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scholarship results</CardTitle>
        <CardDescription>
          Published by the sponsor once the marking has been reviewed. Results are shown by school and
          position — pupils are not named.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {published.map((p) => (
          <div key={p.programId} className="space-y-1.5">
            <p className="text-sm font-medium">
              {p.title}
              <span className="ml-2 font-normal text-muted-foreground">
                {p.category.replaceAll("_", " ").toLowerCase()}
              </span>
            </p>
            {p.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scores recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-3">Position</th>
                      <th className="py-1 pr-3">School</th>
                      <th className="py-1 pr-3 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r, i) => (
                      <tr key={`${p.programId}-${i}`} className="border-t border-border">
                        <td className="py-1 pr-3">
                          {r.position ? (
                            <Badge variant="secondary">
                              {r.position === 1 ? "1st" : r.position === 2 ? "2nd" : "3rd"}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-1 pr-3">{r.schoolName}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.scorePct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
