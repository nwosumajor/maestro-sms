import type { ClassDto, WorkflowSummaryDto, Serialized } from "@sms/types";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

type WorkflowDto = Serialized<WorkflowSummaryDto>;

export default async function DashboardPage() {
  const session = await auth();
  const user = session!.user;

  // Fire the two scoped reads in parallel; either may be null if the role lacks
  // the permission (RBAC) — render 0 rather than failing the page.
  const [classes, workflows] = await Promise.all([
    apiGet<ClassDto[]>("/classes/mine"),
    apiGet<WorkflowDto[]>("/workflows"),
  ]);

  const pending = (workflows ?? []).filter(
    (w) => w.state === "PENDING_REVIEW",
  ).length;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="dashboard" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome, {user.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {user.schoolName} · signed in as
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {user.roles.map((r) => (
              <Badge key={r} variant="secondary">
                {r}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardDescription>My classes</CardDescription>
              <CardTitle className="text-3xl">{(classes ?? []).length}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href="/classes" className="text-sm font-medium text-primary hover:underline">
                View classes →
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardDescription>Approvals awaiting review</CardDescription>
              <CardTitle className="text-3xl">{pending}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href="/workflows" className="text-sm font-medium text-primary hover:underline">
                Open approvals →
              </Link>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your permissions</CardTitle>
            <CardDescription>
              Fine-grained grants from your roles. The API enforces these on every
              request; the UI only hides what you cannot do.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {user.permissions.length === 0 ? (
                <span className="text-sm text-muted-foreground">No permissions.</span>
              ) : (
                user.permissions.map((p) => (
                  <code
                    key={p}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {p}
                  </code>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
