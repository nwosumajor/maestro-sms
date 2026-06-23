import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { NotificationInbox, type InboxData } from "@/components/notifications/NotificationInbox";
import { SendAnnouncement } from "@/components/notifications/SendAnnouncement";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await auth();
  const user = session!.user;
  const canSend = hasPermission(user.permissions, "notification.send");
  const [data, users] = await Promise.all([
    apiGet<InboxData>("/notifications"),
    canSend ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="notifications" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your inbox. Attendance alerts, invoices, receipts, and announcements
            arrive here; external email delivery happens asynchronously.
          </p>
        </div>
        {data === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>Your session expired — sign in again.</AlertDescription>
          </Alert>
        ) : (
          <>
            {canSend && users && <SendAnnouncement users={users} />}
            <NotificationInbox initial={data} />
          </>
        )}
      </div>
    </AppShell>
  );
}
