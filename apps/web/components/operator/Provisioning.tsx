"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MODULE_CATALOG, PLANS, PLAN_MODULES, resolveModules, type ModuleKey, type Plan } from "@sms/types";
import { postWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Tenant = { id: string; name: string };
/** Pre-fill from a public onboarding request ("Approve & provision"). */
export type ProvisionPrefill = {
  requestId: string;
  schoolName: string;
  desiredSlug: string | null;
  contactName: string;
  contactEmail: string;
  desiredPlan: string | null;
  desiredModules: string[] | null;
};
const ROLES = ["school_admin", "principal", "head_admin", "hr_manager"] as const;
const PLAN_LIST: Plan[] = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE];
const isPlanKey = (s: string | null): s is Plan => !!s && (PLAN_LIST as string[]).includes(s);

/** Lowercase, hyphenated, [a-z0-9-] only — matches the API's slug rule. */
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
type CreatedAdmin = { email: string; role: string; tempPassword: string };
type ProvisionResult = { school: string; plan: string; admins: CreatedAdmin[] };

export function Provisioning({ tenants, prefill }: { tenants: Tenant[]; prefill?: ProvisionPrefill | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  // Credentials are shown ONCE, in a copyable panel that AUTO-HIDES after a
  // short window (or on dismiss) so temp passwords never linger on screen.
  const [credentials, setCredentials] = React.useState<ProvisionResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const CREDENTIAL_TTL_S = 10 * 60;
  const [credsLeft, setCredsLeft] = React.useState(CREDENTIAL_TTL_S);
  React.useEffect(() => {
    if (!credentials) return;
    setCredsLeft(CREDENTIAL_TTL_S);
    const id = window.setInterval(() => {
      setCredsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          setCredentials(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart per panel
  }, [credentials]);

  // Provision a school + its founding admin tier (school_admin + principal).
  // When entered via "Approve & provision", the fields start from the public
  // request: name/slug/plan/modules from the request, and BOTH founding
  // accounts' sign-in emails are AUTO-GENERATED from the slug (admin@<slug>
  // .school / principal@<slug>.school — login identifiers, editable). The
  // requester's contact email stays on the request for correspondence; the
  // provision email sends them the sign-in emails + set-password links.
  // (The parent keys this component on the request id, so state re-initialises.)
  const initialSlug = prefill ? (prefill.desiredSlug ?? slugify(prefill.schoolName)) : "";
  const [name, setName] = React.useState(prefill?.schoolName ?? "");
  const [slug, setSlug] = React.useState(initialSlug);
  const [slugTouched, setSlugTouched] = React.useState(Boolean(prefill?.desiredSlug));
  const [aName, setAName] = React.useState(prefill?.contactName ?? "");
  const [aEmail, setAEmail] = React.useState(prefill ? `admin@${initialSlug}.school` : "");
  const [pName, setPName] = React.useState(prefill ? "Principal" : "");
  const [pEmail, setPEmail] = React.useState(prefill ? `principal@${initialSlug}.school` : "");
  // Generated sign-in emails track the slug until the operator edits them.
  const [aEmailTouched, setAEmailTouched] = React.useState(false);
  const [pEmailTouched, setPEmailTouched] = React.useState(false);
  const syncGeneratedEmails = (nextSlug: string) => {
    if (!prefill || !nextSlug) return;
    if (!aEmailTouched) setAEmail(`admin@${nextSlug}.school`);
    if (!pEmailTouched) setPEmail(`principal@${nextSlug}.school`);
  };

  // Plan tier + extra add-on modules (force-on beyond the plan bundle).
  const [plan, setPlan] = React.useState<Plan>(isPlanKey(prefill?.desiredPlan ?? null) ? (prefill!.desiredPlan as Plan) : PLANS.ENTERPRISE);
  const [extras, setExtras] = React.useState<Set<ModuleKey>>(() => {
    if (!prefill?.desiredModules?.length) return new Set();
    const chosenPlan = isPlanKey(prefill.desiredPlan) ? (prefill.desiredPlan as Plan) : PLANS.ENTERPRISE;
    const included = new Set<string>(PLAN_MODULES[chosenPlan]);
    return new Set(prefill.desiredModules.filter((m): m is ModuleKey => !included.has(m)));
  });
  const inPlan = React.useMemo(() => new Set<ModuleKey>(PLAN_MODULES[plan]), [plan]);
  // Modules NOT in the chosen plan are the "extra" add-ons the operator can include.
  const addOnCatalog = MODULE_CATALOG.filter((m) => !inPlan.has(m.key));
  const changePlan = (next: Plan) => {
    setPlan(next);
    // Drop extras that the new plan already includes.
    setExtras((prev) => new Set([...prev].filter((m) => !new Set(PLAN_MODULES[next]).has(m))));
  };
  const toggleExtra = (m: ModuleKey) =>
    setExtras((prev) => {
      const next = new Set(prev);
      next.has(m) ? next.delete(m) : next.add(m);
      return next;
    });
  const effectiveModules = resolveModules(plan, { enabled: [...extras], disabled: [] });

  // Add an admin
  const [schoolId, setSchoolId] = React.useState(tenants[0]?.id ?? "");
  const [bName, setBName] = React.useState("");
  const [bEmail, setBEmail] = React.useState("");
  const [bRole, setBRole] = React.useState<(typeof ROLES)[number]>("school_admin");

  const provision = async (e: React.FormEvent) => {
    e.preventDefault();
    // Tell the operator exactly what's missing instead of silently doing nothing.
    const missing: string[] = [];
    if (!name.trim()) missing.push("school name");
    if (!slug.trim()) missing.push("slug");
    if (!aName.trim()) missing.push("school admin name");
    if (!aEmail.trim()) missing.push("school admin email");
    if (pName.trim() && !pEmail.trim()) missing.push("principal email");
    if (pEmail.trim() && !pName.trim()) missing.push("principal name");
    if (missing.length > 0) {
      setResult(`Please fill in: ${missing.join(", ")}.`);
      return;
    }
    setBusy("provision");
    setResult(null);
    const admins = [{ name: aName.trim(), email: aEmail.trim(), role: "school_admin" }];
    if (pName.trim() && pEmail.trim()) admins.push({ name: pName.trim(), email: pEmail.trim(), role: "principal" });
    const res = await postWithStepUp("operator/tenants", {
      name: name.trim(),
      slug,
      plan,
      overrides: { enabled: [...extras], disabled: [] },
      admins,
      // Provisioning from a public request flips it to APPROVED server-side.
      ...(prefill ? { onboardingRequestId: prefill.requestId } : {}),
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { school: { name: string }; admins: CreatedAdmin[] };
      setCredentials({ school: d.school.name, plan, admins: d.admins });
      setCopied(false);
      setResult(null);
      setName(""); setSlug(""); setSlugTouched(false); setAName(""); setAEmail(""); setPName(""); setPEmail("");
      setAEmailTouched(false); setPEmailTouched(false);
      setPlan(PLANS.ENTERPRISE); setExtras(new Set());
      // Drop the ?provision=<id> param so a refresh doesn't re-prefill.
      if (prefill) router.push("/operator");
      router.refresh();
    } else setResult(await readApiError(res));
  };

  const copyCredentials = async (c: ProvisionResult) => {
    const text = [
      `School: ${c.school} (${c.plan} plan)`,
      ...c.admins.map((a) => `${a.role}: ${a.email} / ${a.tempPassword}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const addAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing: string[] = [];
    if (!schoolId) missing.push("school");
    if (!bName.trim()) missing.push("name");
    if (!bEmail.trim()) missing.push("email");
    if (missing.length > 0) {
      setResult(`Please fill in: ${missing.join(", ")}.`);
      return;
    }
    setBusy("admin");
    setResult(null);
    const res = await postWithStepUp(`operator/tenants/${schoolId}/admins`, {
      name: bName.trim(), email: bEmail.trim(), role: bRole,
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as CreatedAdmin;
      const schoolName = tenants.find((t) => t.id === schoolId)?.name ?? "the school";
      setCredentials({ school: schoolName, plan: "existing", admins: [d] });
      setCopied(false);
      setResult(null);
      setBName(""); setBEmail("");
      router.refresh();
    } else setResult(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onboard a school</CardTitle>
        <CardDescription>
          Create a tenant + its founding admin tier (a school_admin and, recommended, a principal). They then
          staff the rest of the school themselves. Or add admins to an existing school. Step-up re-auth required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {prefill && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span>
              Pre-filled from <span className="font-medium">{prefill.schoolName}</span>&apos;s onboarding request —
              creating the school will mark the request approved.
            </span>
            <button type="button" onClick={() => router.push("/operator")} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              Clear
            </button>
          </div>
        )}
        <form onSubmit={provision} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="pv-name">School name</Label>
              <Input
                id="pv-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) {
                    const next = slugify(e.target.value); // auto-derive until edited
                    setSlug(next);
                    syncGeneratedEmails(next);
                  }
                }}
                placeholder="St. Mary's"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pv-slug">Slug <span className="font-normal text-muted-foreground">(lowercase, a–z 0–9 -)</span></Label>
              <Input
                id="pv-slug"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  const next = slugify(e.target.value);
                  setSlug(next);
                  syncGeneratedEmails(next);
                }}
                placeholder="st-marys"
                className="w-40"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label htmlFor="pv-aname">School admin name</Label><Input id="pv-aname" value={aName} onChange={(e) => setAName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="pv-aemail">School admin sign-in email</Label><Input id="pv-aemail" type="email" value={aEmail} onChange={(e) => { setAEmailTouched(true); setAEmail(e.target.value); }} /></div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label htmlFor="pv-pname">Principal name <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="pv-pname" value={pName} onChange={(e) => setPName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="pv-pemail">Principal sign-in email</Label><Input id="pv-pemail" type="email" value={pEmail} onChange={(e) => { setPEmailTouched(true); setPEmail(e.target.value); }} /></div>
          </div>
          {prefill && (
            <p className="text-xs text-muted-foreground">
              Sign-in emails are auto-generated from the slug (editable). On create, the requester
              ({prefill.contactEmail}) is emailed both sign-in emails with one-time set-password links —
              temporary passwords appear only here, never in email.
            </p>
          )}

          {/* Subscription tier + extra add-on modules (what the school pays for). */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-3">
              <Label htmlFor="pv-plan">Plan</Label>
              <select
                id="pv-plan"
                value={plan}
                onChange={(e) => changePlan(e.target.value as Plan)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {PLAN_LIST.map((pl) => <option key={pl} value={pl}>{pl}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">{effectiveModules.length} modules enabled</span>
            </div>
            {addOnCatalog.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">Extra modules (beyond the {plan} plan)</p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                  {addOnCatalog.map((m) => (
                    <label key={m.key} className="flex items-center gap-1.5 text-sm" title={m.description}>
                      <input type="checkbox" checked={extras.has(m.key)} onChange={() => toggleExtra(m.key)} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button type="submit" disabled={busy === "provision"}>Create school</Button>
        </form>

        {tenants.length > 0 && (
          <form onSubmit={addAdmin} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="ad-school">Existing school</Label>
              <select id="ad-school" value={schoolId} onChange={(e) => setSchoolId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="ad-name">Name</Label><Input id="ad-name" value={bName} onChange={(e) => setBName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="ad-email">Email</Label><Input id="ad-email" type="email" value={bEmail} onChange={(e) => setBEmail(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-role">Role</Label>
              <select id="ad-role" value={bRole} onChange={(e) => setBRole(e.target.value as (typeof ROLES)[number])} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button type="submit" variant="outline" disabled={busy === "admin"}>Add admin</Button>
          </form>
        )}

        {result && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {result}
          </p>
        )}

        {credentials && (
          <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">
                {credentials.plan === "existing"
                  ? `Admin added to ${credentials.school}`
                  : `${credentials.school} created on the ${credentials.plan} plan`}
              </p>
              <button
                type="button"
                onClick={() => void copyCredentials(credentials)}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
              >
                {copied ? "Copied ✓" : "Copy all"}
              </button>
            </div>
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              ⚠ These temporary passwords are shown only once and auto-hide in{" "}
              <span className="tnum">{Math.floor(credsLeft / 60)}:{String(credsLeft % 60).padStart(2, "0")}</span>.
              Copy and share them securely now — the requester was emailed the sign-in emails and
              set-password links, never the passwords.
            </p>
            <ul className="space-y-1">
              {credentials.admins.map((a) => (
                <li key={a.email} className="rounded bg-background/70 px-2 py-1 font-mono text-xs">
                  <span className="text-muted-foreground">{a.role}</span> {a.email}
                  {" · "}
                  <span className="font-semibold">{a.tempPassword}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setCredentials(null)}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
