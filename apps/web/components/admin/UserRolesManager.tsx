"use client";

import type { UserWithEmailDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type User = Serialized<UserWithEmailDto>;

export function UserRolesManager({ users, allRoles }: { users: User[]; allRoles: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ userId: string; kind: "pending" | "error"; text: string } | null>(null);

  const assign = async (userId: string, roleName: string) => {
    if (!roleName) return;
    setBusy(userId);
    setNotice(null);
    const res = await fetch(`/api/sms/admin/users/${userId}/roles`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roleName }),
    });
    setBusy(null);
    if (!res.ok) {
      setNotice({ userId, kind: "error", text: await readApiError(res) });
      return;
    }
    // Junior-admin-tier grants are maker-checker: the API raises an approval
    // request instead of granting, so tell the maker where it went.
    const body = (await res.json().catch(() => null)) as { pendingApproval?: boolean } | null;
    if (body?.pendingApproval) {
      setNotice({ userId, kind: "pending", text: `Sent for approval — "${roleName}" will apply once a different senior approves it under Approvals.` });
    }
    router.refresh();
  };
  const remove = async (userId: string, roleName: string) => {
    setBusy(userId);
    setNotice(null);
    const res = await fetch(`/api/sms/admin/users/${userId}/roles/${roleName}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) {
      setNotice({ userId, kind: "error", text: await readApiError(res) });
      return;
    }
    router.refresh();
  };

  return (
    <div className="space-y-2">
      {users.map((u) => (
        <Card key={u.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-muted-foreground">{u.email}</div>
              {notice?.userId === u.id && (
                <div className={`mt-1 text-xs ${notice.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {notice.text}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {u.roles.map((r) => (
                <Badge key={r} variant="secondary" className="cursor-pointer" onClick={() => remove(u.id, r)} title="Click to remove">
                  {r} ✕
                </Badge>
              ))}
              <select
                disabled={busy === u.id}
                defaultValue=""
                onChange={(e) => { assign(u.id, e.target.value); e.currentTarget.value = ""; }}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground"
              >
                <option value="" disabled>+ role…</option>
                {allRoles.filter((r) => !u.roles.includes(r)).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
