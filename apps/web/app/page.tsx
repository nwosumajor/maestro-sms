import Link from "next/link";

// Minimal landing so "/" isn't a 404. A real marketing/login entry replaces this.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">School Management System</h1>
      <p className="text-sm text-muted-foreground">
        Multi-tenant LMS, integrity monitoring, gradebook, and approval workflows.
      </p>
      <Link
        href="/api/auth/signin"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Sign in
      </Link>
    </main>
  );
}
