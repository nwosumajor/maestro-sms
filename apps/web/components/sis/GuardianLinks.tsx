// Who this pupil's parent actually is.
//
// `parent_child` has always decided the things that matter — who receives the
// absence alert, the fee notice and the report card; whose "My children" page
// shows this pupil; which invoices a parent may open — and there was nowhere in
// the product to read one back. A teacher or a principal looking at a pupil
// could not see which account was attached, or how to reach it.
//
// Not the same as the emergency contacts below it. Those are people to
// telephone, typed in as free text. This is the ACCOUNT the system is sending
// things to, and when a family says "we never got the invoice" it is the first
// thing to check.

import type { StudentGuardianDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UnlinkGuardian } from "./UnlinkGuardian";
import { LinkGuardian } from "./LinkGuardian";

type Guardian = Serialized<StudentGuardianDto>;

/**
 * A SERVER component, deliberately: it displays and does nothing else, so there
 * is nothing for a client island to buy. As one it cost an extra BFF round trip
 * per pupil view and made the card pop in after hydration, below content that
 * was already painted.
 *
 * `rows === null` means the read did not happen — refused, or it failed. The
 * card hides. It must NOT fall back to an empty array: `[]` renders "no parent
 * account is linked", which is a statement about this family that a failed read
 * has no standing to make.
 */
export function GuardianLinks({
  rows,
  studentId,
  canManage,
}: {
  rows: Guardian[] | null;
  studentId: string;
  /** `guardian.write` — the same permission that attaches an adult to a child. */
  canManage: boolean;
}) {
  if (rows === null) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Linked parent / guardian accounts</CardTitle>
        <CardDescription>
          Where this pupil&apos;s absence alerts, invoices, receipts and report cards are sent. Separate from the
          emergency contacts — those are people to telephone; these are accounts that sign in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          // Stated plainly, because it is a real operational problem rather than
          // an empty list: nothing this school sends will reach this family.
          <p className="text-sm text-amber-700 dark:text-amber-500">
            No parent account is linked to this pupil. Nothing sent to guardians — absence alerts, invoices, report
            cards — will reach anybody. Link one from the class page.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Name</th>
                <th className="py-1 pr-3 font-medium">Email</th>
                <th className="py-1 pr-3 font-medium">Phone</th>
                <th className="py-1 pr-3 font-medium">Reachable</th>
                {canManage && <th className="py-1 font-medium sr-only">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-b border-border/50 last:border-0">
                  <td className="py-1 pr-3">{g.name}</td>
                  <td className="py-1 pr-3 text-muted-foreground">{g.email ?? "—"}</td>
                  <td className="py-1 pr-3 text-muted-foreground">{g.phone ?? "—"}</td>
                  <td className="py-1 pr-3">
                    {g.reachableByEmail ? (
                      <Badge variant="secondary">Email</Badge>
                    ) : (
                      // A provisioned account can carry a generated sign-in
                      // identifier rather than a mailbox. Everything emailed to
                      // it vanishes, and nobody finds out from the sending side.
                      <Badge variant="destructive">No mailbox</Badge>
                    )}
                  </td>
                  {canManage && (
                    <td className="py-1 text-right">
                      <UnlinkGuardian studentId={studentId} parentId={g.id} guardianName={g.name} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Both halves of the same job, beside the list they change: this card
            could show that the wrong adult was attached and offered nothing to
            do about it, and attaching the right one meant going to another
            page and re-selecting the pupil you were already looking at. */}
        {canManage && <LinkGuardian studentId={studentId} />}
      </CardContent>
    </Card>
  );
}
