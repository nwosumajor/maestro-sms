"use client";

// =============================================================================
// PlatformStaff — the owner hiring, equipping and revoking help
// =============================================================================
// Owner-only (platform.staff.manage): staff creating staff would mean one manager
// could mint another, and "only the owner has absolute control" quietly dissolves.
// The API pins the role to manager_admin, so this panel can never mint a second
// super_admin however it is driven.
//
// Invite-link only — we never show or send a password (same posture as school
// onboarding). New staff are created MFA-mandatory and must set a password on
// first login.
//
// THE LINK IS SHOWN HERE, deliberately. Hiring used to email the link and show
// the owner nothing — and the email service reports success when it has no
// provider configured, so on most deployments this created a manager that nobody
// could ever sign in as, with every step reporting success. The owner is the one
// person entitled to hand the link over; withholding it protected nothing and
// broke the feature. It is still a link, never a password: single-use, 7 days.
// =============================================================================

import { useEffect, useState } from "react";
import type { Serialized } from "@sms/types";
import type { PlatformStaffDto, PlatformStaffInviteDto } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

type Staff = Serialized<PlatformStaffDto>;
type Invite = Serialized<PlatformStaffInviteDto>;

/** Human-readable duty name — the raw permission key is precise but unfriendly. */
const DUTY_LABELS: Record<string, string> = {
  "platform.tenants.write": "provision & edit schools",
  "platform.tenants.status": "enable / disable a school",
  "platform.tenants.region": "set a school's country",
  "platform.onboarding.review": "triage signup requests",
  "platform.audit.read": "read the platform audit trail",
  "platform.accounts.read": "look up & unlock accounts",
  "platform.grace.manage": "grant billing grace",
  "platform.feedback.manage": "handle feedback",
  "platform.subscription.manage": "change a school's plan",
};
const dutyLabel = (p: string) => DUTY_LABELS[p] ?? p;

function relative(iso: string | null): string {
  if (!iso) return "not since sign-in tracking began";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

export function PlatformStaff() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const res = await fetch("/api/sms/operator/platform-staff");
    if (res.ok) setStaff((await res.json()) as Staff[]);
    else setNote(interpretApiError(res.status, await res.text()));
  }
  useEffect(() => {
    void load();
  }, []);

  // The link is a credential-setting URL. It stays on screen only as long as it
  // takes to hand over — the same auto-hide the school console uses for temp
  // passwords, so a shared screen does not leave one sitting there all afternoon.
  useEffect(() => {
    if (!invite) return;
    const t = setTimeout(() => setInvite(null), 10 * 60_000);
    return () => clearTimeout(t);
  }, [invite]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    setNote(null);
    const res = await sendWithStepUp("POST", "operator/platform-staff", { email, name });
    if (res.ok) {
      setInvite((await res.json()) as Invite);
      setEmail("");
      setName("");
      setNote(null);
      await load();
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(null);
  }

  async function reissue(s: Staff) {
    if (
      s.activated &&
      !window.confirm(
        `${s.name} has already set a password. Re-issuing sends a fresh set-password link — use this only if they are locked out or have lost access. Continue?`,
      )
    )
      return;
    setBusy(s.id);
    setNote(null);
    const res = await sendWithStepUp("POST", `operator/platform-staff/${s.id}/invite`, {});
    if (res.ok) setInvite((await res.json()) as Invite);
    else setNote(interpretApiError(res.status, await res.text()));
    setBusy(null);
  }

  async function revokeDuties(s: Staff) {
    if (
      !window.confirm(
        `Hand back all ${s.duties.length} duties lent to ${s.name}? They keep their account and the standing floor (view tenants, read notifications), and can be lent duties again at any time.`,
      )
    )
      return;
    setBusy(s.id);
    setNote(null);
    const res = await sendWithStepUp("POST", `operator/platform-staff/${s.id}/revoke-duties`, {});
    if (res.ok) {
      const { revoked } = (await res.json()) as { revoked: number };
      setNote(`Handed back ${revoked} ${revoked === 1 ? "duty" : "duties"} from ${s.name}. This applies on their next request.`);
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    await load();
    setBusy(null);
  }

  async function setStatus(id: string, status: "ACTIVE" | "DISABLED") {
    if (status === "DISABLED" && !window.confirm("Revoke this manager? They will be signed out and blocked from logging in.")) return;
    setBusy(id);
    setNote(null);
    const res = await sendWithStepUp("PUT", `operator/platform-staff/${id}/status`, { status });
    if (!res.ok) setNote(interpretApiError(res.status, await res.text()));
    await load();
    setBusy(null);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Platform staff</h2>
        <span className="text-xs text-muted-foreground">manager_admin — delegated duties, never ownership</span>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        A manager&rsquo;s standing role is only the floor: view tenants and read notifications. Every real duty is
        lent below for a fixed window and expires on its own. They can never impersonate, reset credentials, change
        pricing, or read student records — those stay with you.
      </p>

      <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          placeholder="name@yourcompany.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-8 w-64 text-sm"
        />
        <Input
          required
          placeholder="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-48 text-sm"
        />
        <Button type="submit" size="sm" className="h-8" disabled={busy === "add"}>
          {busy === "add" ? "Inviting…" : "Invite manager"}
        </Button>
      </form>

      {invite && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Set-password link for {invite.staff.name}</span>
            {invite.emailDelivered ? (
              <Badge variant="secondary">emailed to {invite.staff.email}</Badge>
            ) : (
              <Badge variant="destructive">not emailed — send this yourself</Badge>
            )}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            {invite.emailDelivered
              ? "They have it by email. Keep this copy in case it does not arrive."
              : "No email provider is configured, so nothing was sent. This link is the only way they can activate the account — pass it on directly. It hides from this screen in 10 minutes."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{invite.inviteLink}</code>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => {
                void navigator.clipboard.writeText(invite.inviteLink);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setInvite(null)}>
              Hide
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Single use, valid 7 days. It sets a password only — it is not a sign-in, and it expires the moment it is used.
          </p>
        </div>
      )}

      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}

      <ul className="divide-y divide-border/70">
        {staff?.length === 0 && <li className="py-2 text-xs text-muted-foreground">No platform staff yet.</li>}
        {staff?.map((s) => (
          <li key={s.id} className="py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  <Badge variant={s.status === "ACTIVE" ? "secondary" : "destructive"}>{s.status.toLowerCase()}</Badge>
                  {!s.activated && <Badge variant="outline">invite pending</Badge>}
                  {s.locked && <Badge variant="destructive">locked out</Badge>}
                  {s.mfaEnabled ? <Badge variant="secondary">2FA on</Badge> : <Badge variant="outline">2FA not set up</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">
                  {s.email} · last signed in {s.activated ? relative(s.lastLoginAt) : "never"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7" disabled={busy === s.id} onClick={() => void reissue(s)}>
                  {s.activated ? "Send reset link" : "Resend invite"}
                </Button>
                {s.duties.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7" disabled={busy === s.id} onClick={() => void revokeDuties(s)}>
                    Hand back all duties
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy === s.id}
                  onClick={() => setStatus(s.id, s.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}
                >
                  {s.status === "ACTIVE" ? "Revoke" : "Reinstate"}
                </Button>
              </div>
            </div>

            {/* What this manager can actually DO right now. Stated positively and
                with an expiry, because "who has what today" is the question this
                console exists to answer. */}
            <div className="mt-1.5 pl-0.5 text-xs">
              {s.duties.length === 0 ? (
                <span className="text-muted-foreground">Standing floor only — no duties currently lent.</span>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {s.duties.map((d) => (
                    <li
                      key={d.id}
                      title={`${d.permission} — ${d.reason}`}
                      className="rounded border border-border bg-background px-1.5 py-0.5"
                    >
                      {dutyLabel(d.permission)}{" "}
                      <span className={d.daysLeft <= 3 ? "text-destructive" : "text-muted-foreground"}>
                        · {d.daysLeft <= 1 ? "expires today" : `${d.daysLeft}d left`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
