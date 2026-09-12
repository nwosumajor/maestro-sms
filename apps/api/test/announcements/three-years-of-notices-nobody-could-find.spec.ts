// =============================================================================
// 501 notices, 100 reachable, and no way to search them
// =============================================================================
// The notice board returned the newest 100 with no count, no page and no
// search. Measured live on a five-year school posting ~2.5 notices a week:
//
//     held                501
//     principal reached   100, back to 2025-01-26
//     parent reached      100, back to 2024-11-09
//     said there was more nothing
//
// So three to four years of what the school had told families were unreachable
// at any URL. A board is read to answer "what did the school say about X", and
// that question had no answer beyond the last few months.
//
// The AUDIENCE rule is not the defect and must not move: a parent sees ALL,
// staff see ALL and STAFF. Widening the REACH must not widen who may read what,
// so the search and the count are both scoped by audience too — a total the
// caller cannot actually read would be worse than no total.
// =============================================================================

import { AnnouncementsService } from "../../src/announcements/announcements.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "A", userId: "head", roles: ["principal"],
  permissions: ["announcement.read", "announcement.manage"],
};
const parent: Principal = {
  schoolId: "A", userId: "p1", roles: ["parent"], permissions: ["announcement.read"],
};

/** Five years of notices; every fifth is STAFF-only. */
const NOTICES = Array.from({ length: 501 }, (_, i) => ({
  id: `n-${String(i).padStart(4, "0")}`,
  schoolId: "A",
  title: i % 11 === 0 ? `Speech Day notice ${i}` : `Notice ${i}`,
  body: i % 11 === 0 ? "Speech Day arrangements" : `Body ${i}`,
  audience: i % 5 === 0 ? "STAFF" : "ALL",
  createdById: "head",
  createdAt: new Date(Date.now() - (501 - i) * 3 * 86_400_000),
  updatedAt: new Date(),
}));

function makeService(rows = NOTICES) {
  // Models the predicate the service sends: the audience `in`, and the
  // title/body OR search. A double ignoring either reports a search that is not
  // happening, or an audience rule that is not applied.
  const match = (where: Record<string, unknown> = {}) => {
    const aud = (where.audience as { in?: string[] } | undefined)?.in;
    const or = (where.OR ?? []) as Array<Record<string, { contains?: string }>>;
    return rows.filter((r) => {
      if (aud && !aud.includes(r.audience)) return false;
      if (or.length) {
        const needle = (or[0]?.title?.contains ?? "").toLowerCase();
        const hay = `${r.title} ${r.body}`.toLowerCase();
        if (needle && !hay.includes(needle)) return false;
      }
      return true;
    });
  };
  const tx = {
    announcement: {
      findMany: jest.fn(async ({ where, take, skip }: Record<string, never>) => {
        const out = [...match(where)].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
    },
    user: { findMany: jest.fn(async () => [{ id: "head", name: "Head" }]) },
  } as unknown as TenantTx;

  const svc = new AnnouncementsService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a board five years of notices deep", () => {
  it("SAYS how many notices there are, not how many fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.list(head);
    expect(r.items.length).toBeLessThan(501);
    expect(r.total).toBe(501);
    expect(r.shown).toBe(r.items.length);
  });

  it("FINDS a notice from year one by name — the question the board answers", async () => {
    const { svc } = makeService();
    const recent = await svc.list(head);
    const target = "Speech Day notice 11";
    expect(recent.items.some((a) => a.title === target)).toBe(false);
    const found = await svc.list(head, { q: target });
    expect(found.items.map((a) => a.title)).toContain(target);
  });

  it("searches in the DATABASE, not over the page it already fetched", async () => {
    const { svc, tx } = makeService();
    await svc.list(head, { q: "Speech" });
    const calls = (tx as unknown as { announcement: { findMany: jest.Mock } }).announcement.findMany.mock.calls;
    expect(JSON.stringify(calls[0][0].where)).toMatch(/contains/);
  });

  it("counts the MATCHES when searching, not the whole board", async () => {
    const { svc } = makeService();
    const r = await svc.list(head, { q: "Speech Day" });
    expect(r.total).toBeLessThan(501);
    expect(r.total).toBeGreaterThan(0);
  });

  it("reaches the older notices BY PAGE, without repeating one", async () => {
    const { svc } = makeService();
    const seen = new Set<string>();
    for (let page = 1; page <= 6; page += 1) {
      const r = await svc.list(head, { page });
      for (const a of r.items) seen.add(a.id);
    }
    expect(seen.size).toBe(501);
  });
});

describe("the audience rule does not move", () => {
  it("a parent never sees a STAFF notice, search or not", async () => {
    const { svc } = makeService();
    const plain = await svc.list(parent);
    const searched = await svc.list(parent, { q: "Notice" });
    expect(plain.items.every((a) => a.audience !== "STAFF")).toBe(true);
    expect(searched.items.every((a) => a.audience !== "STAFF")).toBe(true);
  });

  it("the TOTAL a parent is shown counts only what they may read", async () => {
    // A total the caller cannot reach would be worse than no total: it would
    // tell a family that notices exist which they are not allowed to open.
    const { svc } = makeService();
    const forParent = await svc.list(parent);
    const forHead = await svc.list(head);
    expect(forParent.total).toBeLessThan(forHead.total);
    expect(forParent.total + NOTICES.filter((n) => n.audience === "STAFF").length).toBe(forHead.total);
  });
});
