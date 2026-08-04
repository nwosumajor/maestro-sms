import { IntegrityRetentionService } from "../../src/integrity/retention/integrity-retention.service";

// =============================================================================
// The two tables that grew forever
// =============================================================================
// A ten-year, fifty-school deployment projects to ~50M game guesses and ~10M
// notifications. Both were purged by nothing. Neither is a record anyone asks
// for — the game RESULT and placings live on their own tables, and a read
// notification is a receipt of a conversation whose subject (the invoice, the
// register, the report card) survives independently.
//
// The two rules that make this safe, and that these tests exist to hold:
//   • only FINISHED games lose their guesses — an in-flight game's guesses ARE
//     the game
//   • only READ notifications are removed, at any age. An unread notice is an
//     outstanding thing to tell someone; deleting it silently is worse than
//     keeping it forever.

describe("platform-wide purge of the unbounded growers", () => {
  function client() {
    const raw: string[] = [];
    return {
      raw,
      client: {
        gatewayEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        notification: { deleteMany: jest.fn().mockResolvedValue({ count: 7 }) },
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          raw.push(strings.join("?"));
          return Promise.resolve(3);
        }),
      },
    };
  }

  it("only removes guesses from FINISHED games", async () => {
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    const guessSql = raw.find((r) => r.includes("DELETE FROM guess"));
    expect(guessSql).toBeDefined();
    expect(guessSql).toMatch(/status = 'FINISHED'/);
  });

  it("joins guesses to the GAME's state, not the guess's age alone", async () => {
    // A long-running league match is still live months after its first guess.
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    const guessSql = raw.find((r) => r.includes("DELETE FROM guess"))!;
    expect(guessSql).toMatch(/USING game/);
    expect(guessSql).toMatch(/g\."gameId" = gm\.id/);
  });

  it("never removes an UNREAD notification, at any age", async () => {
    const { client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    const where = c.notification.deleteMany.mock.calls[0][0].where;
    expect(where.readAt.not).toBeNull();
    expect(where.readAt.lt).toBeInstanceOf(Date);
  });

  it("clears delivery rows before the notification they hang off", async () => {
    // notification_delivery FKs to notification; the other order fails on the FK
    // and leaves the purge half-done every night.
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    expect(raw.some((r) => r.includes("DELETE FROM notification_delivery"))).toBe(true);
    expect(c.notification.deleteMany).toHaveBeenCalled();
  });

  it("reports what it removed, so a silent no-op is visible", async () => {
    const { client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    const out = (await (svc as unknown as { purgePlatformWide: () => Promise<Record<string, number>> })["purgePlatformWide"]()) as Record<string, number>;
    expect(out.gameGuesses).toBe(3);
    expect(out.readNotifications).toBe(7);
  });

  it("does nothing at all without the privileged client", async () => {
    const svc = new IntegrityRetentionService({ client: null } as never);
    const out = (await (svc as unknown as { purgePlatformWide: () => Promise<Record<string, number>> })["purgePlatformWide"]()) as Record<string, number>;
    expect(out).toEqual({ gatewayEvents: 0, contentRevisions: 0, gameGuesses: 0, readNotifications: 0 });
  });
});
