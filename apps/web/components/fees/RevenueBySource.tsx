// =============================================================================
// What each part of the school brought in
// =============================================================================
// Hostel rent, transport fares, library fines and academic fees all land on the
// same invoice so a family gets ONE bill and ONE balance. The cost of that —
// until each line started recording which module raised it — was that "what did
// boarding bring in this term?" had no answer anywhere in the product.
//
// PER CURRENCY, one table each, never summed across: invoices carry their own
// currency per row, so one figure would be kobo added to cents.
// =============================================================================

import type { FeeSourceReportDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

type Report = Serialized<FeeSourceReportDto>;

export function RevenueBySource({ reports }: { reports: Report[] }) {
  if (reports.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Funds by department</CardTitle>
        <CardDescription>
          Every charge is recorded by the part of the school that raised it, so boarding, transport, the library and
          academic fees can be read separately even though a family receives one bill.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {reports.map((r) => {
          const pct = (n: number) => (r.billedMinor > 0 ? Math.round((n / r.billedMinor) * 100) : 0);
          return (
            <div key={r.currency} className="space-y-2">
              {reports.length > 1 && <p className="text-xs font-medium text-muted-foreground">{r.currency}</p>}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">Department</th>
                      <th className="py-1 pr-3 text-right font-medium">Billed</th>
                      <th className="py-1 pr-3 text-right font-medium">Collected</th>
                      <th className="py-1 pr-3 text-right font-medium">Outstanding</th>
                      <th className="py-1 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sources.map((s) => (
                      <tr key={s.source} className="border-b border-border/50">
                        <td className="py-1.5 pr-3">
                          {s.label}
                          {s.source === "UNATTRIBUTED" && (
                            <span className="block text-xs text-muted-foreground">
                              charges raised before departments were recorded, and any payment received against a bill
                              with nothing on it — counted here rather than as any one department
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(s.billedMinor, r.currency)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(s.collectedMinor, r.currency)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {s.outstandingMinor > 0 ? money(s.outstandingMinor, r.currency) : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">{pct(s.billedMinor)}%</td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <td className="py-1.5 pr-3">Total</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{money(r.billedMinor, r.currency)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{money(r.collectedMinor, r.currency)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {r.outstandingMinor > 0 ? money(r.outstandingMinor, r.currency) : "—"}
                      </td>
                      <td className="py-1.5" />
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* SAY WHICH PART OF THE FIGURE IS A CONVENTION. A payment settles
                  an invoice, not a line, so on a bill mixing tuition and rent a
                  part payment does not say which part it paid. Mixing is COMMON
                  — the hostel and transport runs add to a family's existing
                  draft bill rather than raising a second one — so this is a
                  material share of the figure above, not a footnote. Silence
                  would let a convention read as a measurement. */}
              {r.mixedCollectedMinor > 0 && (
                <p className="text-xs text-muted-foreground">
                  {money(r.mixedCollectedMinor, r.currency)} of the collected figure came from bills covering more than
                  one department, split across them in proportion to what each charged. The rest is exact.
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
