"use client";

// Which currencies the platform's card account can actually charge, against
// what the schools on it bill in.
//
// The platform used a list of what PAYSTACK supports as though it answered what
// THIS ACCOUNT supports. It does not: an account enabled only for NGN answers
// `403 Currency not supported by merchant` for GHS, KES, ZAR and USD alike. So a
// school billing in GHS was routed to the rail and its parents met an
// unexplained refusal at checkout, while the "use mobile money instead" path
// that exists for exactly this never fired.
//
// Enabling a currency is a dashboard action nobody can take from here. What was
// missing was knowing WHICH ones to enable and who is stuck behind each — this
// is that, on one screen, worst first.

import type { CurrencyCoverageDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Coverage = Serialized<CurrencyCoverageDto>;

export function CurrencyCoverage() {
  const [data, setData] = React.useState<Coverage | null>(null);

  React.useEffect(() => {
    void (async () => {
      const res = await fetch("/api/sms/operator/payment-channels/currency-coverage", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Coverage);
    })();
  }, []);

  if (!data) return null;
  const gaps = data.rows.filter((r) => !r.covered);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Card currencies</CardTitle>
        <CardDescription>
          {data.known ? (
            <>
              The payment account is enabled for {data.merchantCurrencies.join(", ") || "nothing"}.{" "}
              {gaps.length === 0
                ? "Every school's billing currency is covered."
                : `${gaps.length} currency/currencies in use are NOT enabled — parents at those schools are refused at checkout.`}
            </>
          ) : (
            // Unknown is reported as unknown. Telling an operator every currency
            // is unsupported because a balance read timed out would be worse
            // than saying nothing.
            <>The payment account could not be asked which currencies it is enabled for. Shown as covered until it can.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Currency</th>
              <th className="py-1 pr-3 font-medium">Schools</th>
              <th className="py-1 pr-3 font-medium">Can charge</th>
              <th className="py-1 font-medium">Who</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.currency} className="border-b border-border/50 last:border-0">
                <td className="py-1 pr-3 font-medium">{r.currency}</td>
                <td className="py-1 pr-3">{r.schoolCount}</td>
                <td className="py-1 pr-3">
                  {r.covered ? (
                    <Badge variant="secondary">Yes</Badge>
                  ) : r.railSupports ? (
                    // The provider handles it; this account is not switched on
                    // for it. One dashboard change away.
                    <Badge variant="destructive">Enable it</Badge>
                  ) : (
                    <Badge variant="outline">Not on this rail</Badge>
                  )}
                </td>
                <td className="py-1 text-xs text-muted-foreground">
                  {r.sample.join(", ")}
                  {r.schoolCount > r.sample.length && ` +${r.schoolCount - r.sample.length} more`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {gaps.some((g) => !g.railSupports) && (
          <p className="mt-2 text-xs text-muted-foreground">
            A currency the rail does not carry at all is not a dashboard fix — those schools collect by mobile money.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
