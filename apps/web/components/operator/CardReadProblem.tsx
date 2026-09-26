// What a platform-dashboard card shows when its figures are not there — only
// what is KNOWN, never a guessed cause, and always a way to try again.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CardRead } from "@/lib/card-read";
import { AnalyticsRefresh } from "./AnalyticsRefresh";

export function CardReadProblem({ title, read }: { title: string; read: Exclude<CardRead<unknown>, { state: "ok" }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {read.state === "unavailable" ? (
          <p className="text-sm text-muted-foreground">These figures are not available to your account.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              The figures could not be loaded just now
              {read.status !== null ? ` (the server answered ${read.status})` : " (the server could not be reached)"}. This
              is usually temporary — try again in a moment. If it keeps happening, the API logs will say why; one cause
              is a privileged database connection that has not been configured.
            </p>
            <AnalyticsRefresh />
          </>
        )}
      </CardContent>
    </Card>
  );
}
