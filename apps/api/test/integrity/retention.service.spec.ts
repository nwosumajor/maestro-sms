import { Logger } from "@nestjs/common";
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
    expect(guessSql).toMatch(/JOIN game gm/);
    expect(guessSql).toMatch(/g\."gameId" = gm\.id/);
  });

  it("never removes an UNREAD notification, at any age", async () => {
    // The single most important rule here: an unread notice is an outstanding
    // thing to tell someone. Asserted on the SQL, since batching moved this off
    // the Prisma client — the mechanism changed, the property did not.
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    void c;
    const noteSql = raw.find((r) => r.includes("DELETE FROM notification"))!;
    expect(noteSql).toMatch(/"readAt" IS NOT NULL/);
  });

  it("does NOT delete delivery rows separately — the FK already cascades", async () => {
    // An earlier version cleared them first and claimed the other order would
    // fail on the FK. It would not: notification_delivery's FK is ON DELETE
    // CASCADE, so the extra statement was pure cost. Pinned so it does not
    // come back.
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    void c;
    expect(raw.some((r) => r.includes("notification_delivery"))).toBe(false);
  });

  it("deletes in BOUNDED batches, never one statement over the whole table", async () => {
    // The first sweep on a mature database faces everything that has aged past
    // a brand-new window at once. Unbounded, that is one enormous transaction
    // that locks, floods the WAL, and on failure rolls back and retries the
    // same delete forever.
    const { raw, client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    void c;
    const bounded = raw.filter((r) => r.includes("DELETE FROM guess") || r.includes("DELETE FROM notification"));
    expect(bounded.length).toBeGreaterThan(0);
    for (const sql of bounded) expect(sql).toMatch(/LIMIT/);
  });

  it("stops at the batch ceiling and WARNS rather than reporting success", async () => {
    // A sweep that silently hits its ceiling every night looks identical to one
    // with nothing left to do, while the table keeps growing.
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const c = {
      gatewayEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notification: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      // Always returns a FULL batch => there is always more to do.
      $executeRaw: jest.fn().mockResolvedValue(20_000),
    };
    const svc = new IntegrityRetentionService({ client: c } as never);
    await (svc as unknown as { purgePlatformWide: () => Promise<unknown> })["purgePlatformWide"]();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ceiling/i));
    warn.mockRestore();
  });

  it("reports what it removed, so a silent no-op is visible", async () => {
    const { client: c } = client();
    const svc = new IntegrityRetentionService({ client: c } as never);
    const out = (await (svc as unknown as { purgePlatformWide: () => Promise<Record<string, number>> })["purgePlatformWide"]()) as Record<string, number>;
    // One partial batch each (3 < the batch size), so the loop stops after one.
    expect(out.gameGuesses).toBe(3);
    expect(out.readNotifications).toBe(3);
  });

  it("does nothing at all without the privileged client", async () => {
    const svc = new IntegrityRetentionService({ client: null } as never);
    const out = (await (svc as unknown as { purgePlatformWide: () => Promise<Record<string, number>> })["purgePlatformWide"]()) as Record<string, number>;
    expect(out).toEqual({ gatewayEvents: 0, contentRevisions: 0, gameGuesses: 0, readNotifications: 0, jobRuns: 0 });
  });
});

// =============================================================================
// A scheduled job's own history is unbounded too
// =============================================================================
// Fifteen jobs, some hourly, and nothing ever pruned `job_run` — well over a
// million rows in ten years, behind the operator console that reads them, for
// no purpose: nobody diagnoses a sweep from a run eighteen months ago.
describe("pruning job-run history", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/integrity/retention/integrity-retention.service.ts"),
    "utf8",
  ) as string;
  const stmt = SRC.slice(SRC.indexOf("DELETE FROM job_run"), SRC.indexOf("DELETE FROM job_run") + 700);

  it("deletes by age", () => {
    expect(stmt).toMatch(/jr\."startedAt" < \$\{jobCutoff\}/);
  });

  it("ALWAYS keeps the most recent run of each job, however old it is", () => {
    // The subtlety the whole thing turns on. A plain age cutoff blanks the
    // console for anything that runs rarely — a weekly sweep whose last run
    // falls outside the window would read as "never run", which is precisely
    // the alarm that screen exists to raise, on a job that is perfectly fine.
    expect(stmt).toMatch(/jr\.id <> \(/);
    expect(stmt).toMatch(/WHERE latest\.job = jr\.job/);
    expect(stmt).toMatch(/ORDER BY latest\."startedAt" DESC/);
  });

  it("is batched like the other unbounded deletes", () => {
    // A first run against ten years of history must not be one enormous
    // statement.
    expect(SRC).toMatch(/deleteInBatches\("job runs"/);
    expect(stmt).toMatch(/LIMIT \$\{limit\}/);
  });

  it("counts what it removed, so the sweep can report it", () => {
    expect(SRC).toMatch(/jobRuns=\$\{globalCounts\.jobRuns\}/);
  });
});
