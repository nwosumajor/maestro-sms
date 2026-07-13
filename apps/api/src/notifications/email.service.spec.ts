import { EmailService } from "./email.service";
import { EmailChannelProvider } from "./email-channel.provider";
import type { ChannelDeliveryRequest, NotificationChannelProvider } from "./notification.constants";

describe("EmailService", () => {
  const service = new EmailService();
  const realFetch = global.fetch;

  afterEach(() => {
    delete process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_FROM;
    global.fetch = realFetch;
  });

  it("is a log-only no-op when EMAIL_API_KEY is unset (never crashes the pipeline)", async () => {
    const calls: unknown[] = [];
    global.fetch = ((...a: unknown[]) => {
      calls.push(a);
      throw new Error("must not be called");
    }) as typeof fetch;
    const res = await service.send("a@b.c", "Subj", "Body");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("sends via Resend by default with the right payload", async () => {
    process.env.EMAIL_API_KEY = "re_test";
    process.env.EMAIL_FROM = "SMS <no-reply@x.y>";
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const res = await service.send("head@school.ng", "Receipt", "Paid.");
    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("https://api.resend.com/emails");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({ from: "SMS <no-reply@x.y>", to: ["head@school.ng"], subject: "Receipt", text: "Paid." });
  });

  it("sends via Postmark when EMAIL_PROVIDER=postmark", async () => {
    process.env.EMAIL_API_KEY = "pm_test";
    process.env.EMAIL_PROVIDER = "postmark";
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    await service.send("a@b.c", "S", "T");
    expect(captured!.url).toBe("https://api.postmarkapp.com/email");
    expect((captured!.init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("pm_test");
    expect(JSON.parse(String(captured!.init.body)).To).toBe("a@b.c");
  });

  it("reports failure (never throws) on provider errors and network faults", async () => {
    process.env.EMAIL_API_KEY = "k";
    global.fetch = (async () => ({ ok: false, status: 422 }) as Response) as unknown as typeof fetch;
    expect((await service.send("a@b.c", "S", "T")).ok).toBe(false);
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await service.send("a@b.c", "S", "T")).ok).toBe(false);
  });
});

describe("EmailChannelProvider", () => {
  it("routes EMAIL to the email transport and everything else to the inner provider", async () => {
    const emailed: string[] = [];
    const inner: string[] = [];
    const email = { send: async (to: string) => (emailed.push(to), { ok: true }) } as unknown as EmailService;
    const innerProvider: NotificationChannelProvider = {
      deliver: async (r: ChannelDeliveryRequest) => (inner.push(r.channel), { ok: true }),
    };
    const provider = new EmailChannelProvider(email, innerProvider);

    await provider.deliver({ channel: "EMAIL", target: "x@y.z", title: "t", body: "b" });
    await provider.deliver({ channel: "SMS", target: "+234...", title: "t", body: "b" });
    await provider.deliver({ channel: "PUSH", target: "tok", title: "t", body: "b" });

    expect(emailed).toEqual(["x@y.z"]);
    expect(inner).toEqual(["SMS", "PUSH"]);
  });
});
