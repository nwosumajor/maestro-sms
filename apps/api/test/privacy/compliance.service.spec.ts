// =============================================================================
// ComplianceService — the 72-hour clock, and the gaps it must not hide
// =============================================================================
// GDPR Art. 33 gives a school 72 hours from BECOMING AWARE of a personal-data
// breach to notify its supervisory authority; Art. 34 says tell the affected
// people too when the risk to them is high. The tests that matter are the ones
// where a school could quietly look compliant when it is not:
//
//   • the clock must run from AWARENESS, not from when the row was typed in;
//   • not notifying is lawful ONLY as a recorded decision, so silence is overdue;
//   • telling the regulator and stopping there must not read as done;
//   • the posture screen must show what is MISSING, not just what is present.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ComplianceService } from "../../src/privacy/compliance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "S", userId: "u-1", roles: ["principal"], permissions: [] };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function makeService(over: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    dataBreachIncident: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "b-1", createdAt: new Date(), closedAt: null, notifiedAuthorityAt: null, notifiedSubjectsAt: null, noNotificationReason: null, status: "OPEN", ...data };
        created.push(row);
        return row;
      }),
      findFirst: jest.fn().mockResolvedValue((over.existing as unknown) ?? null),
      findMany: jest.fn().mockResolvedValue((over.rows as unknown[]) ?? []),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(over.existing as Record<string, unknown>),
        ...data,
      })),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ name: "Ada" }),
      findMany: jest.fn().mockResolvedValue([{ id: "u-1", name: "Ada" }]),
      // 50 pupils ON ROLL. A COUNT now, not a hydrate — consent coverage is a
      // statement about the children who are HERE, so pupils who have left must
      // not sit in the denominator and depress it forever.
      count: jest.fn().mockResolvedValue(50),
    },
    school: {
      findFirst: jest.fn().mockResolvedValue({
        dpoName: (over.dpoName as string) ?? null,
        dpoEmail: (over.dpoEmail as string) ?? null,
        integrityRetentionDays: 180,
      }),
    },
    erasureRequest: { count: jest.fn().mockResolvedValue(2) },
    integrityConsent: { count: jest.fn().mockResolvedValue(40) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn() };
  const region = { forSchool: jest.fn().mockResolvedValue({ compliance: (over.regime as string) ?? "GDPR", country: "GB" }) };
  return { svc: new ComplianceService(db as never, audit as never, region as never), tx, audit, created };
}

const base = { title: "Laptop lost", description: "A staff laptop went missing", discoveredAt: hoursAgo(1).toISOString() };

describe("reportBreach", () => {
  it("starts the clock at AWARENESS, not at the moment it was typed in", async () => {
    // A breach discovered three days ago and recorded today is ALREADY late. If
    // the clock started at creation, every late report would look on time.
    const { svc } = makeService();
    const out = await svc.reportBreach(p, { ...base, discoveredAt: hoursAgo(80).toISOString() });
    expect(out.hoursRemaining).toBeLessThan(0);
    expect(out.overdue).toBe(true);
  });

  it("gives 72 hours from a fresh discovery", async () => {
    const { svc } = makeService();
    const out = await svc.reportBreach(p, base);
    expect(out.hoursRemaining).toBeGreaterThan(70);
    expect(out.overdue).toBe(false);
  });

  it("refuses a discovery date in the future", async () => {
    // The one way to make this register lie in the school's favour: push the
    // deadline out by claiming you have not become aware yet.
    const { svc } = makeService();
    await expect(
      svc.reportBreach(p, { ...base, discoveredAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("defaults the risk to HIGH", async () => {
    // Assuming low risk is the assumption that loses people their notification.
    const { svc, created } = makeService();
    await svc.reportBreach(p, base);
    expect(created[0].riskLevel).toBe("HIGH");
  });

  it("audits the report", async () => {
    const { svc, audit } = makeService();
    await svc.reportBreach(p, base);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.breach.report" }),
      expect.anything(),
    );
  });
});

describe("the overdue rule", () => {
  const row = (o: Record<string, unknown>) => ({
    id: "b-1", title: "t", description: "d", discoveredAt: hoursAgo(100), status: "OPEN", riskLevel: "HIGH",
    affectedCount: 3, dataCategories: null, notifiedAuthorityAt: null, notifiedSubjectsAt: null,
    noNotificationReason: null, reportedById: "u-1", closedAt: null, createdAt: new Date(), ...o,
  });

  it("silence past 72 hours is OVERDUE", async () => {
    const { svc } = makeService({ rows: [row({})] });
    expect((await svc.listBreaches(p))[0].overdue).toBe(true);
  });

  it("a RECORDED decision not to notify is not overdue", async () => {
    // Art. 33(1) excuses notification where the breach is unlikely to result in a
    // risk — but it has to be a decision somebody wrote down, not silence.
    const { svc } = makeService({ rows: [row({ noNotificationReason: "Encrypted disk, no risk to subjects" })] });
    expect((await svc.listBreaches(p))[0].overdue).toBe(false);
  });

  it("notifying the authority clears it", async () => {
    const { svc } = makeService({ rows: [row({ notifiedAuthorityAt: hoursAgo(90) })] });
    expect((await svc.listBreaches(p))[0].overdue).toBe(false);
  });

  it("telling the REGULATOR but not the PEOPLE is flagged separately", async () => {
    // The common failing: Art. 33 done, Art. 34 forgotten. It must not read as
    // finished just because the regulator was told.
    const { svc } = makeService({ rows: [row({ notifiedAuthorityAt: hoursAgo(90) })] });
    const out = (await svc.listBreaches(p))[0];
    expect(out.overdue).toBe(false);
    expect(out.subjectsUnnotified).toBe(true);
  });

  it("puts overdue incidents first", async () => {
    const { svc } = makeService({
      rows: [row({ id: "ok", notifiedAuthorityAt: hoursAgo(90), discoveredAt: hoursAgo(10) }), row({ id: "late" })],
    });
    expect((await svc.listBreaches(p))[0].overdue).toBe(true);
  });
});

describe("updateBreach", () => {
  const existing = {
    id: "b-1", title: "t", description: "d", discoveredAt: hoursAgo(10), status: "OPEN", riskLevel: "HIGH",
    affectedCount: 3, dataCategories: null, notifiedAuthorityAt: null, notifiedSubjectsAt: null,
    noNotificationReason: null, reportedById: "u-1", closedAt: null, createdAt: new Date(),
  };

  it("REFUSES to close a high-risk breach with the people untold and no reason", async () => {
    // Exactly the gap an authority looks for: closed on the school's books,
    // unnotified in the subjects' lives.
    const { svc } = makeService({ existing });
    await expect(svc.updateBreach(p, "b-1", { status: "CLOSED" })).rejects.toThrow(/Art. 34/);
  });

  it("allows closing once the people were told", async () => {
    const { svc } = makeService({ existing });
    await expect(
      svc.updateBreach(p, "b-1", { status: "CLOSED", notifiedSubjectsAt: new Date().toISOString() }),
    ).resolves.toBeDefined();
  });

  it("allows closing with a recorded reason for not telling them", async () => {
    const { svc } = makeService({ existing });
    await expect(
      svc.updateBreach(p, "b-1", { status: "CLOSED", noNotificationReason: "Data was pseudonymised" }),
    ).resolves.toBeDefined();
  });

  it("never lets discoveredAt move", async () => {
    // A register whose start time can be edited proves nothing about lateness.
    const { svc, tx } = makeService({ existing });
    await svc.updateBreach(p, "b-1", { status: "ASSESSED" });
    expect((tx.dataBreachIncident.update as jest.Mock).mock.calls[0][0].data).not.toHaveProperty("discoveredAt");
  });

  it("404s an unknown incident", async () => {
    const { svc } = makeService({ existing: null });
    await expect(svc.updateBreach(p, "nope", { status: "CLOSED" })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("posture — says what is MISSING", () => {
  it("flags an absent DPO under GDPR", async () => {
    // Art. 37: a school processing children's data at scale must designate one.
    const { svc } = makeService({ regime: "GDPR", dpoEmail: null });
    const out = await svc.posture(p);
    expect(out).toMatchObject({ regime: "GDPR", dpoRequired: true, dpoMissing: true });
  });

  it("stops flagging once a DPO is recorded", async () => {
    const { svc } = makeService({ regime: "GDPR", dpoEmail: "dpo@school.test" });
    expect((await svc.posture(p)).dpoMissing).toBe(false);
  });

  it("reports consent COVERAGE, not just the count on file", async () => {
    // 40 consents against 50 pupils is the lawful-basis question a DPO asks. A
    // page showing only "40 consents recorded" reads as a clean bill of health.
    const { svc } = makeService();
    const out = await svc.posture(p);
    expect(out.consent).toEqual({ recorded: 40, studentsWithout: 10 });
  });

  it("surfaces outstanding erasure requests and the retention window", async () => {
    const { svc } = makeService();
    const out = await svc.posture(p);
    expect(out.erasurePending).toBe(2);
    expect(out.integrityRetentionDays).toBe(180);
  });
});
