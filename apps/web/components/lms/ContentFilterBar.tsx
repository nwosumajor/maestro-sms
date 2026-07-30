import Link from "next/link";

const TYPES: Array<{ value?: string; label: string }> = [
  { label: "All" },
  { value: "LESSON", label: "Lessons" },
  { value: "QUIZ", label: "Quizzes" },
  { value: "ASSIGNMENT", label: "Assignments" },
  { value: "MATERIAL", label: "Materials" },
  { value: "VIDEO", label: "Videos" },
  { value: "FORUM_THREAD", label: "Discussions" },
];

const STATUSES: Array<{ value?: string; label: string }> = [
  { label: "Any status" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Awaiting approval" },
  { value: "PUBLISHED", label: "Published" },
  { value: "REVISION_REQUESTED", label: "Needs revision" },
];

/**
 * Type/status filter for a class's content.
 *
 * Plain links rather than a client island: each one is a normal navigation that
 * re-runs the server query with the filter applied, so choosing "Quizzes" actually
 * fetches fewer rows instead of hiding rows the browser already paid for.
 *
 * Status is staff-only — students see published content and nothing else, so
 * offering them a status filter would imply there is something else to see.
 */
export function ContentFilterBar({
  classId,
  type,
  status,
  showStatus,
}: {
  classId: string;
  type?: string;
  status?: string;
  showStatus: boolean;
}) {
  const href = (next: { type?: string; status?: string }) => {
    const qs = new URLSearchParams();
    const t = "type" in next ? next.type : type;
    const s = "status" in next ? next.status : status;
    if (t) qs.set("type", t);
    if (s) qs.set("status", s);
    const q = qs.toString();
    return `/classes/${classId}/content${q ? `?${q}` : ""}`;
  };

  const chip = (active: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
      active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
    }`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Type</span>
        {TYPES.map((t) => (
          <Link key={t.label} href={href({ type: t.value })} className={chip((type ?? undefined) === t.value)}>
            {t.label}
          </Link>
        ))}
      </div>
      {showStatus && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Status</span>
          {STATUSES.map((s) => (
            <Link key={s.label} href={href({ status: s.value })} className={chip((status ?? undefined) === s.value)}>
              {s.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
