// =============================================================================
// A paid message credit, spent on a WhatsApp message that was never sent
// =============================================================================
// Three correct-looking things composed into a charge for nothing.
//
// 1. Terraform declares `twilio_whatsapp_from` with `default = ""`, so a
//    deployment that does not set it hands the task an EMPTY STRING.
// 2. The provider read it as
//        process.env.TWILIO_WHATSAPP_FROM ?? process.env.TWILIO_FROM
//    and `??` cannot see an empty string, so the fallback the comment beside it
//    described — "falls back to the SMS number" — was unreachable for the
//    commonest possible configuration.
// 3. The empty sender then fell into the `!sid || !token || !from` branch, which
//    logged "no Twilio creds" (untrue — the credentials were fine) and returned
//    `{ ok: true }` to "degrade gracefully".
//
// And `ok` is what `NotificationService` reads to decide whether to debit:
//     if (o.result.ok && o.metered) await this.credits.debitInTx(...)
//
// So the school was charged a credit per WhatsApp message, nothing was sent, and
// every delivery was recorded SENT. The graceful degradation was right for a
// deployment with NO Twilio account — that is the stub case — and wrong the
// moment the credentials are real and only the sender is missing. Those are
// different states and they now have different answers.
// =============================================================================

import { TwilioChannelProvider } from "../../src/notifications/twilio-channel.provider";

const REAL_CREDS = { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "tok_test" };

function provider(env: Record<string, string | undefined>) {
  const saved = process.env;
  process.env = { ...saved, ...env } as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const p = new TwilioChannelProvider();
  const errors: string[] = [];
  const warns: string[] = [];
  (p as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  };
  return { p, errors, warns, restore: () => (process.env = saved) };
}

const whatsapp = { channel: "WHATSAPP" as const, target: "+2348010000000", title: "Fees", body: "Due Friday" };
const sms = { ...whatsapp, channel: "SMS" as const };

describe("Twilio configured, but the WhatsApp sender left empty", () => {
  it("does NOT report success, so no credit is spent", async () => {
    // The single most important assertion in this file: `ok` is the debit
    // condition. Both senders blank, so nothing can be sent and nothing is
    // attempted — the refusal happens at configuration, before any network.
    const t = provider({ ...REAL_CREDS, TWILIO_FROM: "", TWILIO_WHATSAPP_FROM: "" });
    try {
      await expect(t.p.deliver(whatsapp as never)).resolves.toMatchObject({ ok: false });
    } finally {
      t.restore();
    }
  });

  it("falls back to the SMS number when there is one — the documented behaviour", async () => {
    // This is what `??` promised and never did. `fetch` is stubbed so the test
    // asserts the SENDER that was resolved rather than reaching Twilio: a real
    // call here made the suite slow and network-dependent, which is its own bug.
    const t = provider({ ...REAL_CREDS, TWILIO_FROM: "+15550000000", TWILIO_WHATSAPP_FROM: "" });
    const realFetch = globalThis.fetch;
    let sentFrom: string | null = null;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sentFrom = new URLSearchParams(init.body).get("From");
      return { ok: true, json: async () => ({ sid: "SM1" }), text: async () => "" };
    }) as never;
    try {
      await t.p.deliver(whatsapp as never);
      // The SMS number, with the WhatsApp prefix — the fallback fired.
      expect(sentFrom).toBe("whatsapp:+15550000000");
      expect(t.errors.filter((e) => /no sender is set/.test(e))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      t.restore();
    }
  });

  it("only refuses when BOTH senders are empty", async () => {
    const t = provider({ ...REAL_CREDS, TWILIO_FROM: "", TWILIO_WHATSAPP_FROM: "" });
    try {
      await expect(t.p.deliver(whatsapp as never)).resolves.toMatchObject({ ok: false });
      expect(t.errors.join(" ")).toMatch(/TWILIO_WHATSAPP_FROM or TWILIO_FROM/);
    } finally {
      t.restore();
    }
  });

  it("says the credentials are fine and the SENDER is missing", async () => {
    // The old line said "no Twilio creds", which sends an operator to rotate a
    // key that was never the problem.
    const t = provider({ ...REAL_CREDS, TWILIO_FROM: "", TWILIO_WHATSAPP_FROM: "" });
    try {
      await t.p.deliver(sms as never);
      expect(t.errors.join(" ")).toMatch(/Twilio is configured but no sender is set/);
      expect(t.errors.join(" ")).toMatch(/No message credit has been spent/);
      expect(t.warns.join(" ")).not.toMatch(/no Twilio creds/);
    } finally {
      t.restore();
    }
  });
});

describe("a deployment with no Twilio account at all", () => {
  it("still degrades gracefully and reports ok — that part was right", async () => {
    // The distinction the fix rests on: not configured is a supported state and
    // must not fail the pipeline; mis-configured is a fault.
    const t = provider({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined });
    try {
      await expect(t.p.deliver(sms as never)).resolves.toMatchObject({ ok: true });
      expect(t.warns.join(" ")).toMatch(/messaging disabled/);
    } finally {
      t.restore();
    }
  });

  it("treats blank credentials the same as absent ones", async () => {
    // Terraform's default for twilio_account_sid is "" as well.
    const t = provider({ TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM: "" });
    try {
      await expect(t.p.deliver(sms as never)).resolves.toMatchObject({ ok: true });
      expect(t.warns.join(" ")).toMatch(/messaging disabled/);
    } finally {
      t.restore();
    }
  });
});
