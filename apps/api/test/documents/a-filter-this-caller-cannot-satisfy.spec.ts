/**
 * A FILTER THIS CALLER CANNOT SATISFY RETURNS NOTHING — never everyone they CAN
 * see.
 *
 * Three list reads scoped by relationship shared one line:
 *
 *   where.studentId = opts.studentId && ids.includes(opts.studentId)
 *     ? opts.studentId
 *     : { in: ids };
 *
 * Read carefully, the fallback fires when the caller asks about somebody
 * OUTSIDE their scope — and it silently DROPS the filter, answering with every
 * pupil they can see. Nothing leaks: each row was already inside their scope.
 * What is wrong is that the list does not answer the question it was asked, and
 * it looks exactly as though it did.
 *
 * Found live: a teacher asked `/documents?studentId=<a pupil they do not
 * teach>` and got 200 with a report card belonging to a DIFFERENT child — and
 * the same body came back for a uuid that is nobody at all. On a page whose
 * rows are downloadable, that is a document read as belonging to the child you
 * filtered for.
 *
 * The fees one is the same shape on money: a parent filtering by another
 * family's child was handed their OWN children's invoices.
 *
 * Refuse, never widen — the rule the school archive already states about a term
 * it cannot bound. NOT an empty page: the test that pinned the old behaviour is
 * right that "no documents" reads as a fact about that child and hides the
 * refusal. 404 is what every per-student route already answers, so this agrees
 * with them and discloses nothing a random id would not.
 */
import { DocumentsService } from "../../src/documents/documents.service";
import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["document.read"] };
const parent: Principal = { schoolId: "A", userId: "p1", roles: ["parent"], permissions: ["fee.read"] };

/** The pupils this caller may see. Anything else is out of scope. */
const MINE = ["stu-mine"];

function docsHarness() {
  const queried: Array<Record<string, unknown>> = [];
  const tx = {
    document: {
      findMany: jest.fn((args: { where: Record<string, unknown> }) => {
        queried.push(args.where);
        return Promise.resolve([{ id: "doc-1" }]);
      }),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new DocumentsService(
    db as never, { record: jest.fn() } as never, {} as never,
    { enqueue: jest.fn() } as never,
  );
  // The scope itself is not what this test is about — it is fixed, so the only
  // variable is what the caller ASKS for.
  jest.spyOn(svc as never, "visibleStudentIds").mockResolvedValue(MINE as never);
  jest.spyOn(svc as never, "isStaffWide").mockReturnValue(false as never);
  return { svc, queried };
}

describe("a filter this caller cannot satisfy", () => {
  it("documents: a pupil outside the caller's scope is REFUSED", async () => {
    const { svc, queried } = docsHarness();
    await expect(svc.listDocuments(teacher, { studentId: "stu-theirs" })).rejects.toMatchObject({
      status: 404,
    });
    // And it must not have gone to the database at all with a widened filter.
    expect(queried).toEqual([]);
  });

  it("documents: a pupil INSIDE the scope filters to exactly that pupil", async () => {
    const { svc, queried } = docsHarness();
    await svc.listDocuments(teacher, { studentId: "stu-mine" });
    expect(queried[0].studentId).toBe("stu-mine");
  });

  it("documents: no filter still lists every pupil the caller may see", async () => {
    // The half that must not be traded away for the fix.
    const { svc, queried } = docsHarness();
    await svc.listDocuments(teacher, {});
    expect(queried[0].studentId).toEqual({ in: MINE });
  });
});

describe("a filter this caller cannot satisfy — invoices", () => {
  function feesHarness() {
    const queried: Array<Record<string, unknown>> = [];
    const tx = {
      invoice: {
        findMany: jest.fn((args: { where: Record<string, unknown> }) => {
          queried.push(args.where);
          return Promise.resolve([]);
        }),
      },
    } as unknown as TenantTx;
    const db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    };
    const svc = Object.create(FeesService.prototype) as FeesService;
    Object.assign(svc, { db });
    jest.spyOn(svc as never, "visibleStudentIds").mockResolvedValue(MINE as never);
    jest.spyOn(svc as never, "isBillingWide").mockReturnValue(false as never);
    jest.spyOn(svc as never, "ctx").mockReturnValue({ schoolId: "A", userId: "p1" } as never);
    return { svc, queried };
  }

  it("another family's child is REFUSED, not answered with your own children's bills", async () => {
    const { svc, queried } = feesHarness();
    await expect(svc.listInvoices(parent, { studentId: "stu-theirs" })).rejects.toMatchObject({
      status: 404,
    });
    expect(queried).toEqual([]);
  });
});
