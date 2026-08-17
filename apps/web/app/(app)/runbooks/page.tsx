import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// The operations documents, in one place.
//
// They were reachable only as a row of links buried on the operator console,
// which is the page you open when something is already happening. A runbook is
// most useful read BEFORE that, and the thing that gets read before it is needed
// is the thing with a door of its own.
//
// Gated on the platform permission, like the documents themselves: the incident
// playbook describes this platform's infrastructure, its rollback procedure and
// what to do about a tenant-isolation breach. The school-facing manual is listed
// here too, and labelled as such, because the owner answers questions about it
// daily and opening the exact page a principal is looking at beats
// reconstructing it from memory.

type Doc = {
  href: string;
  title: string;
  audience: string;
  description: string;
  contents: string[];
  source: string;
  /** A generated PDF file, or the browser's own print export. */
  pdf: { href: string; label: string; note: string };
};

const DOCS: Doc[] = [
  {
    href: "/runbooks/incident",
    title: "Incident response",
    audience: "On-call and platform staff",
    description:
      "What to do when something is wrong, in the order to do it — from deciding severity to writing the post-mortem afterwards.",
    contents: [
      "Severity, decided in under a minute",
      "The first five minutes: is it down, and for whom",
      "Playbooks per symptom — outage, latency, database, Redis, a bad deploy, payments, auth, tenant isolation, data loss, scheduled jobs",
      "Rolling back, and when rolling back is the wrong move",
      "Verifying recovery, and the blameless post-mortem template",
    ],
    source: "docs/RUNBOOK-INCIDENT-RESPONSE.md",
    pdf: { href: "/runbooks/incident.pdf", label: "Download PDF ↓", note: "A generated file — 12 pages." },
  },
  {
    href: "/runbooks/backup",
    title: "Backup & restore",
    audience: "On-call and platform staff",
    description:
      "What is protected, how far back you can go, and the drill that proves a restore actually works rather than assuming it.",
    contents: [
      "What is backed up and for how long",
      "Taking a backup, and pruning old ones",
      "Point-in-time recovery within the retention window",
      "The restore drill: into a throwaway database, asserting RLS and tenant isolation still hold",
      "The version trap that makes a healthy-looking dump unrestorable",
    ],
    source: "docs/RUNBOOK-BACKUP-RESTORE.md",
    pdf: { href: "/runbooks/backup.pdf", label: "Download PDF ↓", note: "A generated file — 3 pages." },
  },
  {
    href: "/manual",
    title: "School Leader's Manual",
    audience: "What schools read — owners and principals",
    description:
      "The handbook a school leader is given: first 30 days, delegating roles, the approval rules behind every control, fees and subscription, and a term-by-term rhythm.",
    contents: [
      "First login, and the account protections",
      "The first 30 days, week by week",
      "Delegating: the role model and its guardrails",
      "Money in (school fees) and money out (your subscription)",
      "The academic core, HR, and communication",
    ],
    source: "docs/ONBOARDING-MANUAL.html",
    // Authored as HTML rather than markdown, and parsed into the SAME block
    // model so it renders through the same emitter as the runbooks.
    pdf: { href: "/manual?format=pdf", label: "Download PDF ↓", note: "A generated file — 14 pages." },
  },
];

export default async function RunbooksPage() {
  const session = await auth();
  const user = session!.user;
  // Same gate as the documents themselves. A school user who reaches this URL is
  // sent to their dashboard rather than shown that an operator surface exists.
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="runbooks"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <PageHeader
          title={<>Runbooks</>}
          subtitle={
            <>
              The operations documents, rendered from the files that are kept up to date in the repository. Each opens
              as a page and prints to PDF. Read them before you need them.
            </>
          }
        />

        <div className="grid gap-4 md:grid-cols-2">
          {DOCS.map((d) => (
            <Card key={d.href} className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{d.title}</CardTitle>
                <CardDescription>
                  <span className="block text-xs uppercase tracking-wide opacity-70">{d.audience}</span>
                  <span className="mt-1 block">{d.description}</span>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-3">
                <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {d.contents.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <a href={d.href} target="_blank" rel="noopener noreferrer">
                      <Button size="sm">Open ↗</Button>
                    </a>
                    {/* The two runbooks serve a real generated file, built from
                        the same parse of the markdown as the page. The manual is
                        authored as HTML and prints through the browser — the
                        label says which, rather than implying they are alike. */}
                    <a href={d.pdf.href} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm">
                        {d.pdf.label}
                      </Button>
                    </a>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {d.pdf.note} Source: <code>{d.source}</code>
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Why these are pages and not files</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              The markdown in <code>docs/</code> stays the single source of truth, because the rule this codebase keeps
              is that a change in operational behaviour updates the runbook in the same change. These pages are
              generated from those files, and a test fails the build if they fall behind — so what you read here is what
              is in the repository, not a copy somebody forgot.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
