import { MEETING_PROVIDER_LABELS, type MeetingProvider } from "@sms/types";

/**
 * The attendee-facing join affordance, shared by parent–teacher slots and
 * calendar (staff) meetings.
 *
 * The SERVER decides whether a link is live: it sends `joinUrl: null` outside the
 * window and `joinOpen: false`, so this component can only ever render what it
 * was given. There is no client-side timer to trick — if the link isn't open yet,
 * the browser was never told it.
 */
export function JoinMeetingLink({
  provider,
  joinUrl,
  joinOpen,
  joinOpensAt,
  location,
}: {
  provider: string | null;
  joinUrl: string | null;
  joinOpen: boolean;
  joinOpensAt: string | Date | null;
  location?: string | null;
}) {
  // No video meeting attached — fall back to the physical location.
  if (!provider) return <span className="text-muted-foreground">{location ?? "—"}</span>;

  const label = MEETING_PROVIDER_LABELS[provider as MeetingProvider] ?? provider;

  if (joinOpen && joinUrl) {
    return (
      <a
        href={joinUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
      >
        Join {label} →
      </a>
    );
  }

  // The host still gets their own link before the window (server decides).
  if (joinUrl) {
    return (
      <span className="text-xs text-muted-foreground">
        {label} ·{" "}
        <a href={joinUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          host link
        </a>
      </span>
    );
  }

  const opens = joinOpensAt ? new Date(joinOpensAt) : null;
  return (
    <span className="text-xs text-muted-foreground">
      {label} · opens{" "}
      {opens ? opens.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "shortly before the start"}
    </span>
  );
}
