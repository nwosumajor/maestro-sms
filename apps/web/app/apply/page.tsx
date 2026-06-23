import { ApplyForm } from "@/components/admissions/ApplyForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A prospective family applies for admission.
export default function ApplyPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
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
