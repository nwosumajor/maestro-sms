import Link from "next/link";
import type { PendingApprovalDto, Serialized } from "@sms/types";
import { APPROVAL_SOURCE_LABELS } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Item = Serialized<PendingApprovalDto>;

function money(minor: number): string {
  return `₦${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Pending decisions that live in OTHER modules (fees, HR, payroll, security,
 * admissions, privacy). Listed here so one page answers "what is waiting on me",
 * but each row deep-links to the module that owns the decision — those keep
 * their own maker-checker rules, step-up and context.
 */
export function OtherApprovals({ items }: { items: Item[] }) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          From other modules
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
        <CardDescription>
          Decisions waiting on you elsewhere in the system. Open each one where it lives — the full context and the approval
          controls are on that page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((it) => (
            <li key={`${it.source}-${it.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{APPROVAL_SOURCE_LABELS[it.source as keyof typeof APPROVAL_SOURCE_LABELS] ?? it.source}</Badge>
                  <span className="font-medium">{it.label}</span>
                  {it.amountMinor !== null && (
                    <span className="font-semibold tabular-nums">{money(it.amountMinor)}</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {it.detail}
                  {it.detail ? " · " : ""}
                  waiting {age(it.createdAt)}
                </p>
              </div>
              <Link href={it.href} className="shrink-0 text-sm font-medium text-primary underline">
                Open to decide →
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
