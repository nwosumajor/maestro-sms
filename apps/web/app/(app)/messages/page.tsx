import type { MessageDto, ThreadSummaryDto, ThreadViewDto, UserSummaryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { dateTime } from "@/lib/format";
import { Composer } from "@/components/messaging/Composer";
import { ReplyBox } from "@/components/messaging/ReplyBox";

export const dynamic = "force-dynamic";

type Thread = Serialized<ThreadSummaryDto>;
type Message = Serialized<MessageDto>;
type ThreadView = Serialized<ThreadViewDto>;
type Contact = Serialized<UserSummaryDto>;

export default async function MessagesPage({ searchParams }: { searchParams: { thread?: string } }) {
  const session = await auth();
  const user = session!.user;
  const canSend = hasPermission(user.permissions, "message.send");
  const [threads, contacts] = await Promise.all([
    apiGet<Thread[]>("/messages/threads"),
    canSend ? apiGet<Contact[]>("/messages/contacts") : Promise.resolve(null),
  ]);
  const selected = searchParams.thread ? await apiGet<ThreadView>(`/messages/threads/${searchParams.thread}`) : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="messages" permissions={user.permissions}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
          {canSend && contacts && <Composer contacts={contacts} />}
        </div>

        <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
          <div className="space-y-2">
            {(threads ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No conversations yet.</p>
            ) : (
              (threads ?? []).map((t) => (
                <Link key={t.id} href={`/messages?thread=${t.id}`}>
                  <Card className={cn("transition-colors hover:border-primary/40", t.id === searchParams.thread && "border-primary")}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{t.subject}</span>
                        {t.unread > 0 && <Badge>{t.unread}</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.lastMessage?.body}</p>
                    </CardContent>
                  </Card>
                </Link>
              ))
            )}
          </div>

          <div>
            {!selected ? (
              <p className="text-sm text-muted-foreground">Select a conversation.</p>
            ) : (
              <Card>
                <CardContent className="space-y-3 p-4">
                  <div className="font-medium">{selected.thread.subject}</div>
                  <div className="space-y-2">
                    {selected.messages.map((m) => (
                      <div key={m.id} className={cn("rounded-md px-3 py-2 text-sm", m.senderId === user.id ? "bg-primary/10 ml-8" : "bg-muted mr-8")}>
                        <p>{m.body}</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">{dateTime(m.createdAt)}</p>
                      </div>
                    ))}
                  </div>
                  {canSend && <ReplyBox threadId={selected.thread.id} />}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
