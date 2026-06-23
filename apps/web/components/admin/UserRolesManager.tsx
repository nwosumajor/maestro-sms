"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface User { id: string; name: string; email: string; roles: string[] }

export function UserRolesManager({ users, allRoles }: { users: User[]; allRoles: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const assign = async (userId: string, roleName: string) => {
    if (!roleName) return;
    setBusy(userId);
    const res = await fetch(`/api/sms/admin/users/${userId}/roles`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roleName }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
  };
  const remove = async (userId: string, roleName: string) => {
    setBusy(userId);
    const res = await fetch(`/api/sms/admin/users/${userId}/roles/${roleName}`, { method: "DELETE" });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-2">
      {users.map((u) => (
        <Card key={u.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-muted-foreground">{u.email}</div>
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
