"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MODULE_CATALOG, PLANS, PLAN_MODULES, resolveModules, type ModuleKey, type Plan } from "@sms/types";
import { postWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Tenant = { id: string; name: string };
const ROLES = ["school_admin", "principal", "head_admin", "hr_manager"] as const;
const PLAN_LIST: Plan[] = [PLANS.BASIC, PLANS.STANDARD, PLANS.ENTERPRISE];

/** Lowercase, hyphenated, [a-z0-9-] only — matches the API's slug rule. */
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
/** Surface the API's actual error message (e.g. the slug rule) instead of a code. */
async function errMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const m = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    return m ? `${m}` : `Failed (${res.status}).`;
  } catch {
    return `Failed (${res.status}).`;
  }
}

export function Provisioning({ tenants }: { tenants: Tenant[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  // Provision a school + its founding admin tier (school_admin + principal).
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [aName, setAName] = React.useState("");
  const [aEmail, setAEmail] = React.useState("");
  const [pName, setPName] = React.useState("");
  const [pEmail, setPEmail] = React.useState("");

  // Plan tier + extra add-on modules (force-on beyond the plan bundle).
  const [plan, setPlan] = React.useState<Plan>(PLANS.ENTERPRISE);
  const [extras, setExtras] = React.useState<Set<ModuleKey>>(new Set());
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
    if (!name || !slug || !aName || !aEmail) return;
    setBusy("provision");
    setResult(null);
    const admins = [{ name: aName, email: aEmail, role: "school_admin" }];
    if (pName && pEmail) admins.push({ name: pName, email: pEmail, role: "principal" });
    const res = await postWithStepUp("operator/tenants", {
      name,
      slug,
      plan,
      overrides: { enabled: [...extras], disabled: [] },
      admins,
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { admins: { email: string; role: string; tempPassword: string }[] };
      setResult(
        `School created on the ${plan} plan. ${d.admins.map((a) => `${a.role} ${a.email} — temp password: ${a.tempPassword}`).join(" · ")}`,
      );
      setName(""); setSlug(""); setSlugTouched(false); setAName(""); setAEmail(""); setPName(""); setPEmail("");
      setPlan(PLANS.ENTERPRISE); setExtras(new Set());
      router.refresh();
    } else setResult(await errMessage(res));
  };

  const addAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schoolId || !bName || !bEmail) return;
    setBusy("admin");
    setResult(null);
    const res = await postWithStepUp(`operator/tenants/${schoolId}/admins`, {
      name: bName, email: bEmail, role: bRole,
    });
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { email: string; tempPassword: string };
      setResult(`Admin ${d.email} added — temporary password: ${d.tempPassword}`);
      setBName(""); setBEmail("");
      router.refresh();
    } else setResult(await errMessage(res));
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
        <form onSubmit={provision} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="pv-name">School name</Label>
              <Input
                id="pv-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value)); // auto-derive until edited
                }}
                placeholder="St. Mary's"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pv-slug">Slug <span className="font-normal text-muted-foreground">(lowercase, a–z 0–9 -)</span></Label>
              <Input
                id="pv-slug"
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
                placeholder="st-marys"
                className="w-40"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label htmlFor="pv-aname">School admin name</Label><Input id="pv-aname" value={aName} onChange={(e) => setAName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="pv-aemail">School admin email</Label><Input id="pv-aemail" type="email" value={aEmail} onChange={(e) => setAEmail(e.target.value)} /></div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label htmlFor="pv-pname">Principal name <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="pv-pname" value={pName} onChange={(e) => setPName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="pv-pemail">Principal email</Label><Input id="pv-pemail" type="email" value={pEmail} onChange={(e) => setPEmail(e.target.value)} /></div>
          </div>

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

        {result && <p className="rounded-md bg-muted px-3 py-2 text-sm font-mono">{result}</p>}
      </CardContent>
    </Card>
  );
}
