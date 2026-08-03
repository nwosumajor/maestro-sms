"use client";

// =============================================================================
// PlatformRoleAudit — platform-tier roles held OUTSIDE the platform org
// =============================================================================
// A finding report that had no screen. It lists accounts inside a customer school
// that hold a platform role — which should be impossible: AdminService refuses
// the grant and login filters `platform.*` to nothing outside the platform org.
// A row can still exist from before those guards, from a hand-edited database, or
// from a restored backup.
//
// The permissions are inert. The GRANT is the finding: it means someone once had,
// or tried to obtain, cross-tenant reach. Exactly the class of thing that turned
// out to be real — a standing super_admin scope survived a purge and sat unseen
// because the tool for spotting it had no way to be looked at.
//
// Renders nothing when the list is empty, which is the expected state. A panel
// that shows "0 findings" every day trains people to stop reading it.
// =============================================================================

import { useState } from "react";
import type { Serialized, MisplacedPlatformRoleDto } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

export function PlatformRoleAudit({ initial }: { initial: Serialized<MisplacedPlatformRoleDto>[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (rows.length === 0) return null;

  async function revoke(r: Serialized<MisplacedPlatformRoleDto>, roleName: string) {
    if (!window.confirm(`Remove "${roleName}" from ${r.email} at ${r.schoolName}?`)) return;
    setBusy(r.userId + roleName);
    setNote(null);
    const res = await sendWithStepUp("DELETE", `operator/platform-role-audit/${r.userId}/${roleName}`, {});
    if (res.ok) {
      setRows((cur) =>
        cur
          .map((x) =>
            x.userId === r.userId ? { ...x, platformRoles: x.platformRoles.filter((n) => n !== roleName) } : x,
          )
          .filter((x) => x.platformRoles.length > 0),
      );
      setNote(`Removed ${roleName} from ${r.email}.`);
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(null);
  }

  return (
    <section className="rounded-lg border border-destructive/40 bg-card p-4">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-destructive">Platform roles held inside a school</h2>
        <Badge variant="destructive">{rows.length} to review</Badge>
      </header>

      <Alert variant="destructive" className="mb-3">
        <AlertTitle>This should not be possible</AlertTitle>
        <AlertDescription className="text-xs">
          A platform-tier role on an account inside a customer school. The permissions are inert — login filters them
          to nothing outside the platform organisation — but the <strong>grant</strong> is the finding: someone once
          had, or tried to obtain, cross-tenant reach. Expect this list to be empty.
        </AlertDescription>
      </Alert>

      <ul className="divide-y divide-border/70">
        {rows.map((r) => (
          <li key={r.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium">{r.name}</span>
                <Badge variant="outline">{r.status.toLowerCase()}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {r.email} · {r.schoolName} · granted {new Date(r.grantedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {r.platformRoles.map((role) => (
                <Button
                  key={role}
                  size="sm"
                  variant="destructive"
                  className="h-7"
                  disabled={busy === r.userId + role}
                  onClick={() => void revoke(r, role)}
                >
                  Remove {role}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
