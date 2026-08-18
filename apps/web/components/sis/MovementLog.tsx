// Where this person has been scanned.
//
// Every gate, library and exam-hall scan wrote a `scan_event` — who was
// scanned, who held the scanner, why, when — and NOTHING read it. A school
// could scan a child out at the gate and then had no way to ask when they
// left, which is the only question a gate log exists to answer. The table even
// carried the indexes such a reader needs; the readers were never written.
//
// A SERVER component: it only displays. `rows === null` means the read did not
// happen — refused, or it failed — and the card hides rather than claiming this
// pupil has never been scanned.

import type { ScanEventDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Scan = Serialized<ScanEventDto>;

const LABEL: Record<string, string> = {
  CHECK_IN: "Arrived",
  CHECK_OUT: "Left",
  LIBRARY: "Library",
  EXAM: "Exam hall",
};

export function MovementLog({ rows, dateTime }: { rows: Scan[] | null; dateTime: (v: string) => string }) {
  if (rows === null) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Recent scans</CardTitle>
        <CardDescription>
          Gate, library and exam-hall scans from the last 30 days, newest first — and who held the
          scanner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans recorded in the last 30 days.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">What</th>
                <th className="py-1 pr-3 font-medium">Scanned by</th>
                <th className="py-1 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-border/50 last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{dateTime(s.at)}</td>
                  <td className="py-1 pr-3">
                    <Badge variant={s.purpose === "CHECK_OUT" ? "outline" : "secondary"}>
                      {LABEL[s.purpose] ?? s.purpose}
                    </Badge>
                  </td>
                  <td className="py-1 pr-3 text-muted-foreground">{s.scannedByName}</td>
                  <td className="py-1 text-muted-foreground">{s.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
