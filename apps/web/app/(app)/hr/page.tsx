import type { EmployeeDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { money, shortDate, titleCase } from "@/lib/format";
import { EmployeeForm } from "@/components/hr/EmployeeForm";

export const dynamic = "force-dynamic";

type Employee = Serialized<EmployeeDto>;

export default async function HrPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "hr.write");
  const [employees, users] = await Promise.all([
    apiGet<Employee[]>("/hr/employees"),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HR — staff records</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Employment records. Salaries are encrypted at rest and shown only to HR readers.
          </p>
        </div>

        {canWrite && users && <EmployeeForm users={users} />}

        {employees === null || employees.length === 0 ? (
          <Alert variant="info"><AlertTitle>No records</AlertTitle><AlertDescription>No employee records yet.</AlertDescription></Alert>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Job title</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Start</th>
                    <th className="px-4 py-2.5 font-medium">Salary</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{e.user?.name ?? "—"}</td>
                      <td className="px-4 py-2.5">{e.jobTitle}{e.department ? ` · ${e.department}` : ""}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{titleCase(e.employmentType)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{shortDate(e.startDate)}</td>
                      <td className="px-4 py-2.5">{e.salaryMinor != null ? money(e.salaryMinor) : "—"}</td>
                      <td className="px-4 py-2.5"><Badge variant={e.status === "ACTIVE" ? "secondary" : "outline"}>{titleCase(e.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
