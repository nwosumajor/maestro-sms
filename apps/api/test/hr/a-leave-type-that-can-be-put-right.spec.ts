/**
 * A leave type could be CREATED and nothing else — no update, no delete — and
 * three things followed:
 *
 *   - `daysPerYear` is the ENTITLEMENT, and a typo (200 for 20) could never be
 *     put right;
 *   - a typo in the name sat in every staff member's apply picker for ever;
 *   - `active` exists on the row precisely so a type created in error can be
 *     retired, and NOTHING ever wrote it — read by `balancesFor`, written by
 *     nobody. The apply picker ignored it too, so retiring one would have
 *     changed nothing a member of staff sees.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LeaveService } from "../../src/hr/leave.service";

function svc(types: Array<Record<string, unknown>>) {
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const tx = {
    leaveType: {
      // A real `findFirst` returns a DETACHED row; handing back the live
      // object the later `update` mutates models something no client does.
      findFirst: async ({ where }: { where: { id: string } }) => {
        const t = types.find((x) => x.id === where.id);
        return t ? { ...t } : null;
      },
      // Honours the WHERE and the DATA, so a service that stopped scoping the
      // write, or stopped writing, cannot pass.
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = types.find((x) => x.id === where.id);
        if (!t) throw new Error("not found");
        Object.assign(t, data);
        return t;
      },
    },
  };
  const s = Object.create(LeaveService.prototype) as LeaveService;
  Object.assign(s, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    ctx: () => ({}),
    audit: { record: async (e: { action: string; metadata?: Record<string, unknown> }) => { audits.push(e); } },
  });
  return { s, audits, types };
}

const P = { userId: "hr", schoolId: "s1", roles: ["hr_manager"], permissions: [] } as never;
const TYPE = () => ({ id: "t1", name: "Anual", daysPerYear: 200, active: true });

describe("a leave type that can be put right", () => {
  it("corrects a typo in the name", async () => {
    const { s, types } = svc([TYPE()]);
    expect((await s.updateLeaveType(P, "t1", { name: "  Annual  " })).name).toBe("Annual");
    expect(types[0].daysPerYear).toBe(200);
  });

  it("corrects the entitlement without restating the name", async () => {
    const { s, types } = svc([TYPE()]);
    expect((await s.updateLeaveType(P, "t1", { daysPerYear: 20 })).daysPerYear).toBe(20);
    expect(types[0].name).toBe("Anual");
  });

  // THE COLUMN THAT NOTHING COULD WRITE.
  it("retires a type, and puts it back", async () => {
    const { s } = svc([TYPE()]);
    expect((await s.updateLeaveType(P, "t1", { active: false })).active).toBe(false);
    expect((await s.updateLeaveType(P, "t1", { active: true })).active).toBe(true);
  });

  it("refuses a blank name rather than storing one", async () => {
    const { s } = svc([TYPE()]);
    await expect(s.updateLeaveType(P, "t1", { name: "   " })).rejects.toThrow(BadRequestException);
  });

  it("404s a type that does not exist", async () => {
    const { s } = svc([TYPE()]);
    await expect(s.updateLeaveType(P, "nope", { name: "x" })).rejects.toThrow(NotFoundException);
  });

  // The change is auditable and says what MOVED, because the entitlement is a
  // figure somebody may later have to account for.
  it("records what the entitlement changed from and to", async () => {
    const { s, audits } = svc([TYPE()]);
    await s.updateLeaveType(P, "t1", { daysPerYear: 20 });
    const row = audits.find((a) => a.action === "hr.leave.type.update");
    expect(row?.metadata).toMatchObject({ daysPerYearFrom: 200, daysPerYearTo: 20 });
  });

  // `@@unique([schoolId, name])` — a rename onto another type's name is a
  // sentence a person reads, never a 500.
  it("translates a duplicate name rather than throwing raw", () => {
    const src = readFileSync(path.join(__dirname, "../../src/hr/leave.service.ts"), "utf8");
    const a = src.indexOf("async updateLeaveType(");
    const body = src.slice(a, src.indexOf("\n  }", a));
    // 409, the same status CREATE already gives for this collision through the
    // global P2002 filter — a guard and the race behind it sharing one answer.
    expect(body).toMatch(/asDuplicateConflict\("A leave type with that name already exists\."/);
    expect(body).not.toMatch(/asDuplicate\(/);
  });
});

describe("a retired type is not offered", () => {
  const APPLY = readFileSync(
    path.join(__dirname, "../../../../apps/web/components/hr/LeaveSelfService.tsx"),
    "utf8",
  );

  // Without this half, retiring a type changes nothing a member of staff sees.
  it("the apply picker filters it out, and does not default to one", () => {
    expect(APPLY).toMatch(/types\.filter\(\(t\) => t\.active !== false\)\.map/);
    expect(APPLY).toMatch(/types\.find\(\(t\) => t\.active !== false\)\?\.id/);
  });

  // RETIRING KEEPS THE HISTORY: it stays on balances already granted and
  // requests already approved. The screen says so, because an HR clerk who
  // fears otherwise will not retire a wrong type at all.
  it("the admin screen says what retiring does not remove", () => {
    const ADMIN = readFileSync(
      path.join(__dirname, "../../../../apps/web/components/hr/LeaveAdmin.tsx"),
      "utf8",
    );
    expect(ADMIN).toMatch(/stays on the balances and requests already made under it/);
    expect(ADMIN).toMatch(/Balances already granted this year keep the entitlement they were opened with/);
  });
});
