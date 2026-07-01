"use client";

import * as React from "react";
import type { OperatorUserDto, Serialized } from "@sms/types";
import { sendWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type User = Serialized<OperatorUserDto>;

// Roles a super_admin may bulk-mandate MFA on (super_admin itself is never targetable).
const MANAGED_ROLES = [
  "principal",
  "school_admin",
  "head_admin",
  "head_teacher",
  "hr_manager",
  "hr_clerk",
  "accountant",
  "teacher",
] as const;

export function OperatorUsers({ schoolId }: { schoolId: string }) {
  const [open, setOpen] = React.useState(false);
  const [users, setUsers] = React.useState<User[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [roleMfa, setRoleMfa] = React.useState<(typeof MANAGED_ROLES)[number]>("teacher");

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/operator/tenants/${schoolId}/users`);
    if (res.ok) setUsers((await res.json()) as User[]);
    else setNote(`Could not load users (${res.status}).`);
  }, [schoolId]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && users === null) await load();
  };

  const act = async (
    key: string,
    method: "POST" | "PUT",
    path: string,
    body?: unknown,
    onResult?: (data: unknown) => void,
  ) => {
    setBusy(key);
    setNote(null);
    const res = await sendWithStepUp(method, path, body);
    setBusy(null);
    if (res.ok) {
      if (onResult) onResult(await res.json().catch(() => ({})));
      await load();
    } else {
      setNote(`Action failed (${res.status}).`);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <button
          onClick={toggle}
          className="text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          {open ? "Hide users" : "Manage users"}
        </button>
        {open && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Require 2FA for role:</span>
            <select
              value={roleMfa}
              onChange={(e) => setRoleMfa(e.target.value as (typeof MANAGED_ROLES)[number])}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            >
              {MANAGED_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={busy === "role-on"}
              onClick={() =>
                act("role-on", "PUT", `operator/tenants/${schoolId}/roles/${roleMfa}/mfa-required`, {
                  required: true,
                }, (d) => setNote(`Required 2FA for ${(d as { affected?: number }).affected ?? 0} ${roleMfa}(s).`))
              }
            >
              Enforce
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={busy === "role-off"}
              onClick={() =>
                act("role-off", "PUT", `operator/tenants/${schoolId}/roles/${roleMfa}/mfa-required`, {
                  required: false,
                })
              }
            >
              Release
            </Button>
          </div>
        )}
      </div>

      {note && <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs font-mono">{note}</p>}

      {open && users && (
        <div className="mt-3 space-y-2">
          {users.length === 0 && <p className="text-sm text-muted-foreground">No users.</p>}
          {users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {u.name}{" "}
                  <span className="font-normal text-muted-foreground">· {u.email}</span>
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">{u.uniqueId}</span>
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge variant={u.status === "ACTIVE" ? "secondary" : "destructive"}>
                    {u.status.toLowerCase()}
                  </Badge>
                  {u.roles.map((r) => (
                    <Badge key={r} variant="outline" className="font-mono text-[10px]">
                      {r}
                    </Badge>
                  ))}
                  {u.mfaEnabled && <Badge variant="secondary">2FA on</Badge>}
                  {u.mfaRequired && <Badge variant="outline">2FA required</Badge>}
                  {u.locked && <Badge variant="destructive">locked</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {u.status === "ACTIVE" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy === `st-${u.id}`}
                    onClick={() =>
                      act(`st-${u.id}`, "PUT", `operator/tenants/${schoolId}/users/${u.id}/status`, {
                        status: "DISABLED",
                      })
                    }
                  >
                    Suspend
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy === `st-${u.id}`}
                    onClick={() =>
                      act(`st-${u.id}`, "PUT", `operator/tenants/${schoolId}/users/${u.id}/status`, {
                        status: "ACTIVE",
                      })
                    }
                  >
                    Reactivate
                  </Button>
                )}
                {u.locked && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy === `ul-${u.id}`}
                    onClick={() =>
                      act(`ul-${u.id}`, "POST", `operator/tenants/${schoolId}/users/${u.id}/unlock`)
                    }
                  >
                    Reactivate (unlock)
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy === `pw-${u.id}`}
                  onClick={() =>
                    act(
                      `pw-${u.id}`,
                      "POST",
                      `operator/tenants/${schoolId}/users/${u.id}/reset-password`,
                      undefined,
                      (d) =>
                        setNote(
                          `Temp password for ${u.email}: ${(d as { tempPassword?: string }).tempPassword ?? "(hidden)"}`,
                        ),
                    )
                  }
                >
                  Reset password
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy === `mr-${u.id}`}
                  onClick={() =>
                    act(`mr-${u.id}`, "POST", `operator/tenants/${schoolId}/users/${u.id}/mfa/reset`)
                  }
                >
                  Reset 2FA
                </Button>
                <Button
                  size="sm"
                  variant={u.mfaRequired ? "ghost" : "outline"}
                  className="h-7"
                  disabled={busy === `rq-${u.id}`}
                  onClick={() =>
                    act(`rq-${u.id}`, "PUT", `operator/tenants/${schoolId}/users/${u.id}/mfa-required`, {
                      required: !u.mfaRequired,
                    })
                  }
                >
                  {u.mfaRequired ? "Release 2FA" : "Require 2FA"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
