// Server component: the reporting-line tree. Roots = staff with no manager;
// children nest under their manager. Pure display — lines are set on the
// employee form (cycle-checked by the API).
import type { OrgNodeDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Node = Serialized<OrgNodeDto>;

function Tree({ nodes, parent, depth }: { nodes: Node[]; parent: string | null; depth: number }) {
  const children = nodes.filter((n) => n.managerId === parent);
  if (children.length === 0) return null;
  return (
    <ul className={depth === 0 ? "space-y-2" : "mt-1 space-y-1 border-l pl-4"}>
      {children.map((n) => (
        <li key={n.userId}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{n.name}</span>
            <span className="text-muted-foreground">{n.jobTitle}</span>
            {n.department && <Badge variant="outline">{n.department}</Badge>}
            {n.gradeLevel && <Badge variant="secondary">{n.gradeLevel}</Badge>}
          </div>
          <Tree nodes={nodes} parent={n.userId} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

export function OrgChart({ nodes }: { nodes: Node[] }) {
  // Anyone whose manager isn't an ACTIVE employee surfaces as a root too, so a
  // mid-tree exit never hides a whole branch.
  const ids = new Set(nodes.map((n) => n.userId));
  const normalized = nodes.map((n) => (n.managerId && ids.has(n.managerId) ? n : { ...n, managerId: null }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organisation</CardTitle>
        <CardDescription>Reporting lines — set each person’s manager on the employee form.</CardDescription>
      </CardHeader>
      <CardContent>
        {normalized.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active staff records yet.</p>
        ) : (
          <Tree nodes={normalized} parent={null} depth={0} />
        )}
      </CardContent>
    </Card>
  );
}
