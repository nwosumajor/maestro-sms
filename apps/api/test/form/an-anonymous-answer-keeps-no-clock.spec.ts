// =============================================================================
// Hiding the name is not enough while the row carries the instant
// =============================================================================
// A form marked `anonymous` hides `respondentName` on read and writes its audit
// row under SYSTEM — both correct, and both already done. What it also returned
// was `createdAt` at MILLISECOND precision, one row per respondent.
//
// This repo already measured that channel on the poll: a vote row and a
// request-log line "thirteen milliseconds apart, so log + database recovers not
// just WHO voted but WHAT THEY CHOSE". That was closed by withholding `user_id`
// from the log ON THE VOTE ROUTE — and every OTHER request the same pupil makes
// still carries their id, so a response stamped to the millisecond is the same
// join from the other end.
//
// Polls are safe because their read returns per-option TALLIES. A form cannot:
// the answers are free text and staff genuinely need each one. So the precision
// goes instead.
//
// Measured live before this, on a form asking pupils how safe they feel:
//   {"respondentName":null,"answers":{"q1":"Not very — a boy in Year 10 keeps
//    taking my things."},"createdAt":"2026-08-27T10:18:12.351Z"}
// =============================================================================

import { FormService } from "../../src/form/form.service";

const AT = new Date("2026-08-27T10:18:12.351Z");

describe("an anonymous answer keeps no clock", () => {
  it("returns the DAY, not the instant, for an anonymous form", async () => {
    const [row] = await responses({ anonymous: true });
    expect(row.createdAt.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("leaves a named form's timestamp exactly as it was", async () => {
    // The precision is only a problem where identity was promised away.
    const [row] = await responses({ anonymous: false });
    expect(row.createdAt.toISOString()).toBe(AT.toISOString());
  });

  it("still hides the respondent's name", async () => {
    const [row] = await responses({ anonymous: true });
    expect(row.respondentName).toBeNull();
  });

  it("does not order an anonymous form by arrival", async () => {
    // The sequence is a second handle: the third row is the third person to
    // answer. Ordering by id gives a stable list that says nothing about when.
    const { orderBy } = await queryFor({ anonymous: true });
    expect(orderBy).toEqual({ id: "asc" });
  });

  it("keeps newest-first for a named form, which is what staff want there", async () => {
    const { orderBy } = await queryFor({ anonymous: false });
    expect(orderBy).toEqual({ createdAt: "desc" });
  });
});

function build(opts: { anonymous: boolean }) {
  let orderBy: unknown = null;
  const tx = {
    form: { findFirst: async () => ({ id: "f1", anonymous: opts.anonymous }) },
    formResponse: {
      findMany: async (a: { orderBy: unknown }) => {
        orderBy = a.orderBy;
        return [{ id: "r1", respondentId: "pupil-1", answers: { q1: "…" }, createdAt: AT }];
      },
    },
    user: { findMany: async () => [{ id: "pupil-1", name: "A Pupil" }] },
  };
  const svc = Object.create(FormService.prototype) as FormService;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: async () => undefined },
  });
  (svc as unknown as { canManage: () => boolean }).canManage = () => true;
  const call = () =>
    (svc as unknown as {
      responses: (p: unknown, id: string) => Promise<Array<{ respondentName: string | null; createdAt: Date }>>;
    }).responses({ userId: "staff", schoolId: "s1", roles: ["principal"], permissions: [] }, "f1");
  return { call, orderByOf: () => orderBy };
}

async function responses(opts: { anonymous: boolean }) {
  return build(opts).call();
}
async function queryFor(opts: { anonymous: boolean }) {
  const b = build(opts);
  await b.call();
  return { orderBy: b.orderByOf() };
}
