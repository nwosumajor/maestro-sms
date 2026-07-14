"use client";

// Creates a new checkers game and jumps into it (you play black; share the link
// or wait for an opponent to join from the lobby list).

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postSms } from "./play-ui";

export function NewCheckersButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const create = async () => {
    setBusy(true);
    const r = await postSms<{ id: string }>("checkers");
    setBusy(false);
    if (r.ok && r.data) router.push(`/games/checkers/${r.data.id}`);
  };
  return (
    <Button onClick={create} disabled={busy}>
      {busy ? "Creating…" : "New game"}
    </Button>
  );
}
