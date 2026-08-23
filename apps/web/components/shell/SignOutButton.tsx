"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

/**
 * Sign out, and land on the login page.
 *
 * `redirect: false` then a manual navigation, for the reason ChangePasswordForm
 * documents: behind a reverse proxy next-auth's own redirect resolves against
 * the internal origin and sends the browser somewhere it cannot reach.
 */
export function SignOutButton({ label = "Sign out" }: { label?: string }) {
  return (
    <Button
      variant="outline"
      onClick={() => {
        void signOut({ redirect: false }).finally(() => {
          window.location.href = "/login";
        });
      }}
    >
      {label}
    </Button>
  );
}
