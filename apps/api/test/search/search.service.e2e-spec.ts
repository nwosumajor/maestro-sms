// =============================================================================
// SearchService — federated global search + scoping (real DB)
// =============================================================================
// Proves: an admin finds students / staff / classes / invoices by query; a
// PARENT searching the same terms sees ONLY their own child (never another
// family's student), no staff, no invoices they can't see; category gating is
// by permission.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { SearchService } from "../../src/search/search.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("SearchService federated search + scoping (real Postgres)", () => {
  let admin: Pool;
  let svc: SearchService;

  const SA = randomUUID();
  const ADMIN = randomUUID();
  const PARENT = randomUUID();
  const MY_CHILD = randomUUID(); // "Searchable Zephyr" — the parent's child
  const OTHER_STUDENT = randomUUID(); // "Searchable Zenith" — another family
  const TEACHER = randomUUID(); // "Searchable Zara" (staff)
  const studentRoleId = randomUUID();
  const teacherRoleId = randomUUID();
  const classId = randomUUID();
  const invoiceId = randomUUID();

  const adminP = (): Principal => ({ userId: ADMIN, schoolId: SA, roles: ["school_admin"], permissions: ["student.profile.read", "class.read", "fee.read", "rbac.manage"] });
  const parentP = (): Principal => ({ userId: PARENT, schoolId: SA, roles: ["parent"], permissions: ["student.profile.read", "class.read", "fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'SR',$2,now())`, [SA, "sr-" + SA]);
    for (const [u, name] of [
      [ADMIN, "Admin"],
      [PARENT, "Parent"],
      [MY_CHILD, "Searchable Zephyr"],
      [OTHER_STUDENT, "Searchable Zenith"],
      [TEACHER, "Searchable Zara"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@sr", name]);
    }
    const stRole = await admin.query(`SELECT id FROM role WHERE name='student'`);
    const teRole = await admin.query(`SELECT id FROM role WHERE name='teacher'`);
    const sid = stRole.rowCount ? (stRole.rows[0] as { id: string }).id : studentRoleId;
    const tid = teRole.rowCount ? (teRole.rows[0] as { id: string }).id : teacherRoleId;
    if (!stRole.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'student')`, [studentRoleId]);
    if (!teRole.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'teacher')`, [teacherRoleId]);
    for (const s of [MY_CHILD, OTHER_STUDENT]) await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, s, sid]);
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, TEACHER, tid]);
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, PARENT, MY_CHILD]);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Searchable Class',now())`, [classId, SA]);
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'SEARCH-INV-1','ISSUED',1000,now(),$4,now())`,
      [invoiceId, SA, MY_CHILD, ADMIN],
    );

    svc = new SearchService(new PrismaTenantService() as never);
  });

  afterAll(async () => {
    for (const t of ["invoice", "class", "parent_child", "user_role"]) await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM role WHERE id = ANY($1)`, [[studentRoleId, teacherRoleId]]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("admin finds students, staff, class and invoice across categories", async () => {
    const res = await svc.search(adminP(), "Searchable");
    const kinds = new Set(res.hits.map((h) => h.kind));
    expect(kinds.has("student")).toBe(true);
    expect(kinds.has("staff")).toBe(true);
    expect(kinds.has("class")).toBe(true);
    const students = res.hits.filter((h) => h.kind === "student").map((h) => h.title);
    expect(students).toEqual(expect.arrayContaining(["Searchable Zephyr", "Searchable Zenith"]));
    const inv = await svc.search(adminP(), "SEARCH-INV");
    expect(inv.hits.some((h) => h.kind === "invoice")).toBe(true);
  });

  it("a parent sees ONLY their own child, no staff, and only their own invoices", async () => {
    const res = await svc.search(parentP(), "Searchable");
    const students = res.hits.filter((h) => h.kind === "student").map((h) => h.title);
    expect(students).toEqual(["Searchable Zephyr"]); // never the other family's student
    expect(res.hits.some((h) => h.kind === "staff")).toBe(false); // no staff directory for parents
    const inv = await svc.search(parentP(), "SEARCH-INV");
    expect(inv.hits.filter((h) => h.kind === "invoice")).toHaveLength(1); // their own child's invoice
  });

  it("a query shorter than 2 chars returns nothing", async () => {
    expect((await svc.search(adminP(), "a")).hits).toEqual([]);
  });
});
