import { ApplyForm } from "@/components/admissions/ApplyForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective family applies for admission.
export default function ApplyPage() {
  return (
    <main className="relative grid min-h-screen place-items-center bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Apply for admission</CardTitle>
          <CardDescription>
            Submit an enquiry to the school. We'll be in touch — your details are
            kept separate from enrolled-student records until reviewed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApplyForm />
        </CardContent>
      </Card>
    </main>
  );
}
