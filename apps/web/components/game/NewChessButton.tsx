"use client";

// Creates a new chess game (you play white) and jumps into it.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postSms } from "./play-ui";

export function NewChessButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const create = async () => {
    setBusy(true);
    const r = await postSms<{ id: string }>("chess");
    setBusy(false);
    if (r.ok && r.data) router.push(`/games/chess/${r.data.id}`);
  };
  return (
    <Button onClick={create} disabled={busy}>
      {busy ? "Creating…" : "New game"}
    </Button>
  );
}
