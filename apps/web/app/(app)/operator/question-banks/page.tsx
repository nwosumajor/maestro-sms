// The scholarship question banks — the platform owner's own exam-authoring
// surface, on its own page rather than a panel inside the scholarship console.
//
// It is its own page because it is its own JOB: an owner sits down to write
// sixty to a hundred questions for one subject, and that is not something done
// in passing while reviewing applications. Gated on scholarship.admin
// (super_admin only; NON_ELEVATABLE), like every other scholarship surface.

import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { QuestionBanks } from "@/components/operator/QuestionBanks";

export const dynamic = "force-dynamic";

export default async function OperatorQuestionBanksPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "scholarship.admin")) redirect("/dashboard");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="operatorquestionbanks"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <PageHeader
          title={<>Scholarship question banks</>}
          subtitle={
            <>
              Write a bank of questions for one subject, then save it. A saved bank can be drawn on by any
              scholarship paper; a bank still being written cannot, so half a paper can never reach a
              candidate. A paper takes a COPY, so correcting a question here changes what future papers are
              built from and never alters one already sat.
            </>
          }
        />
        <QuestionBanks />
      </div>
    </AppShell>
  );
}
