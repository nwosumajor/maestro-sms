// Server component: recent xAPI (Tin Can) learning statements for a class — the
// standards-based activity stream the LRS captured (platform content + any
// external xAPI/SCORM activity). Read-only teacher review.
import type { Serialized, XapiStatementDto } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Statement = Serialized<XapiStatementDto>;

const VERB_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  passed: "default",
  completed: "default",
  failed: "destructive",
  attempted: "secondary",
  answered: "secondary",
  experienced: "outline",
  progressed: "outline",
};

function result(s: Statement): string {
  const r = s.result ?? {};
  const bits: string[] = [];
  if (typeof r.score === "number") bits.push(`${r.score}${typeof r.max === "number" ? `/${r.max}` : ""}`);
  if (r.success === true) bits.push("success");
  if (r.completion === true) bits.push("complete");
  return bits.join(" · ");
}

export function XapiActivity({ statements }: { statements: Statement[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent activity (xAPI)</CardTitle>
        <CardDescription>
          Standards-based learning statements captured by the record store — from platform content and any
          connected xAPI/SCORM activity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {statements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1.5 pr-2">Student</th>
                  <th className="px-2">Verb</th>
                  <th className="px-2">Activity</th>
                  <th className="px-2">Result</th>
                  <th className="px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {statements.slice(0, 50).map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{s.actorName}</td>
                    <td className="px-2">
                      <Badge variant={VERB_VARIANT[s.verb] ?? "outline"}>{s.verb}</Badge>
                    </td>
                    <td className="px-2">{s.objectName}</td>
                    <td className="px-2 tabular-nums text-muted-foreground">{result(s) || "—"}</td>
                    <td className="px-2 text-muted-foreground">
                      {new Date(s.storedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                    </td>
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
