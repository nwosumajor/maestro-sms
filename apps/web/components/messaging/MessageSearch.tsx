"use client";

// Search across the threads you are a participant in. The endpoint was built,
// permission-gated and relationship-scoped — and had no input anywhere.
import Link from "next/link";
import { InlineSearch } from "@/components/common/InlineSearch";

type Hit = { id: string; threadId: string; body: string; createdAt: string; subject: string };

export function MessageSearch() {
  return (
    <InlineSearch<Hit>
      path="messages/search"
      placeholder="Search your messages…"
      emptyLabel="No message matched."
      render={(hits) => (
        <ul className="divide-y divide-border/70 rounded-md border border-border">
          {hits.map((h) => (
            <li key={h.id} className="p-2 text-sm">
              <Link href={`/messages?thread=${h.threadId}`} className="font-medium hover:underline">
                {h.subject || "(no subject)"}
              </Link>
              {/* Trimmed: a search result is a pointer, not the message. */}
              <p className="truncate text-xs text-muted-foreground">{h.body}</p>
            </li>
          ))}
        </ul>
      )}
    />
  );
}
