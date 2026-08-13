// =============================================================================
// Who a teacher may write to — against a real database
// =============================================================================
// The companion source-scan suite pins the SHAPE of the rule. This one runs it:
// two classes, a teacher who takes only one of them, a pupil and a guardian in
// each, and the questions a school actually asks.
//
// Worth doing against Postgres rather than a mock because the rule is a Prisma
// `where` — nested relation filters (`parentLinks: { some: { studentId: … } }`)
// that a jest.fn() would accept without ever evaluating. A mocked version of
// this test passes against the broken code, which is how the original defect
// survived: every messaging test in the repo mocks the tx.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { MessagingService } from "../../src/communication/messaging.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

const SCHOOL = randomUUID();
const TEACHER = randomUUID();
const OTHER_TEACHER = randomUUID();
const PRINCIPAL = randomUUID();
const ACCOUNTANT = randomUUID();
const LIBRARIAN = randomUUID();
const MY_PUPIL = randomUUID();
const MY_PARENT = randomUUID();
const OTHER_PUPIL = randomUUID();
const OTHER_PARENT = randomUUID();
const LEFT_PUPIL = randomUUID();
const MY_CLASS = randomUUID();
const OTHER_CLASS = randomUUID();

const who = (userId: string, roles: string[]): Principal => ({
  schoolId: SCHOOL,
  userId,
  roles,
  permissions: [],
});

d("who a teacher may write to (real Postgres)", () => {
  let admin: Pool;
  let messaging: MessagingService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'Reach',$2,now())`, [
      SCHOOL,
      "reach-" + SCHOOL,
    ]);

    const person = async (id: string, name: string) =>
      admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SCHOOL, `${id}@reach.test`, name],
      );
    await person(TEACHER, "Their Teacher");
    await person(OTHER_TEACHER, "Another Teacher");
    await person(PRINCIPAL, "The Principal");
    await person(ACCOUNTANT, "The Bursar");
    await person(LIBRARIAN, "The Librarian");
    await person(MY_PUPIL, "Their Pupil");
    await person(MY_PARENT, "Their Pupil's Mother");
    await person(OTHER_PUPIL, "Another Class's Pupil");
    await person(OTHER_PARENT, "Another Class's Father");
    await person(LEFT_PUPIL, "A Pupil Who Left");

    // Roles have to exist for the STAFF_OR_TEACHER clause to match a RECIPIENT.
    // `role` is global reference data the seed owns, and a test database built
    // with `db push` has none of it — which silently skipped every role row here
    // and made the suite pass for the wrong reasons. Create by name if absent
    // (idempotent, exactly what the seed does) and never delete: other suites
    // and the seed share these rows.
    for (const roleName of ["teacher", "principal", "accountant", "librarian", "student", "parent"]) {
      await admin.query(
        `INSERT INTO role (id,name,description) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
        [randomUUID(), roleName, `${roleName} (created by messaging-reach e2e)`],
      );
    }
    for (const [id, roleName] of [
      [TEACHER, "teacher"],
      [OTHER_TEACHER, "teacher"],
      [PRINCIPAL, "principal"],
      [ACCOUNTANT, "accountant"],
      [LIBRARIAN, "librarian"],
      [MY_PUPIL, "student"],
      [OTHER_PUPIL, "student"],
      [LEFT_PUPIL, "student"],
      [MY_PARENT, "parent"],
      [OTHER_PARENT, "parent"],
    ] as Array<[string, string]>) {
      const r = await admin.query(`SELECT id FROM role WHERE name = $1 LIMIT 1`, [roleName]);
      // No silent skip: a missing role would weaken the suite invisibly.
      if (!r.rows[0]) throw new Error(`role ${roleName} missing and could not be created`);
      {
        await admin.query(
          `INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [randomUUID(), SCHOOL, id, r.rows[0].id],
        );
      }
    }

    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Mine',now())`, [
      MY_CLASS,
      SCHOOL,
    ]);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Theirs',now())`, [
      OTHER_CLASS,
      SCHOOL,
    ]);
    // The teacher takes MY_CLASS only.
    await admin.query(
      `INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`,
      [randomUUID(), SCHOOL, MY_CLASS, TEACHER],
    );
    await admin.query(
      `INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`,
      [randomUUID(), SCHOOL, OTHER_CLASS, OTHER_TEACHER],
    );

    await admin.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES ($1,$2,$3,$4,'ACTIVE')`,
      [randomUUID(), SCHOOL, MY_CLASS, MY_PUPIL],
    );
    await admin.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES ($1,$2,$3,$4,'ACTIVE')`,
      [randomUUID(), SCHOOL, OTHER_CLASS, OTHER_PUPIL],
    );
    // In the teacher's class, but gone.
    await admin.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES ($1,$2,$3,$4,'WITHDRAWN')`,
      [randomUUID(), SCHOOL, MY_CLASS, LEFT_PUPIL],
    );

    await admin.query(
      `INSERT INTO parent_child (id,"schoolId","parentId","studentId",relationship) VALUES ($1,$2,$3,$4,'Mother')`,
      [randomUUID(), SCHOOL, MY_PARENT, MY_PUPIL],
    );
    await admin.query(
      `INSERT INTO parent_child (id,"schoolId","parentId","studentId",relationship) VALUES ($1,$2,$3,$4,'Father')`,
      [randomUUID(), SCHOOL, OTHER_PARENT, OTHER_PUPIL],
    );

    messaging = new MessagingService(new PrismaTenantService() as never, {
      enqueue: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterAll(async () => {
    // Children before parents — FK order.
    await admin.query(`DELETE FROM message WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM thread_participant WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM message_thread WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM notification WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM parent_child WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM enrollment WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM class_teacher WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM class WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM user_role WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM audit_log WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SCHOOL]);
    await admin.end();
    // Without this the pool keeps the jest worker alive and hangs CI.
    await prisma.$disconnect();
  });

  let lastError = "";
  const canWrite = async (from: Principal, toId: string) => {
    try {
      await messaging.createThread(from, { recipientId: toId, subject: "s", body: "b" });
      return true;
    } catch (e) {
      lastError = (e as Error).message;
      return false;
    }
  };

  const teacher = () => who(TEACHER, ["teacher"]);

  it("a teacher may write to a pupil they teach", async () => {
    // The defect, stated plainly. This was false.
    expect(await canWrite(teacher(), MY_PUPIL)).toBe(true);
  });

  it("a teacher may write to that pupil's parent", async () => {
    // The conversation the whole module exists for, and the one that could only
    // ever be started from the parent's side.
    expect(await canWrite(teacher(), MY_PARENT)).toBe(true);
  });

  it("a teacher may NOT write to a child in another class", async () => {
    // The reason this is relationship-scoped rather than simply widened: an
    // adult opening a private channel to a minor they have no connection to.
    expect(await canWrite(teacher(), OTHER_PUPIL)).toBe(false);
  });

  it("a teacher may NOT write to another class's parent", async () => {
    expect(await canWrite(teacher(), OTHER_PARENT)).toBe(false);
  });

  it("a teacher may NOT write to a pupil who has left their class", async () => {
    // Same rule the roll, the register and the billing seat count use: an
    // enrolment that ended ends the relationship it granted.
    expect(await canWrite(teacher(), LEFT_PUPIL)).toBe(false);
  });

  it("a teacher may still write to colleagues", async () => {
    expect(await canWrite(teacher(), OTHER_TEACHER)).toBe(true);
    expect(await canWrite(teacher(), PRINCIPAL) || lastError).toBe(true);
  });

  it("the principal may write to anyone, including another class's pupil", async () => {
    expect(await canWrite(who(PRINCIPAL, ["principal"]), OTHER_PUPIL)).toBe(true);
  });

  it("the bursar may write to any parent but to NO pupil", async () => {
    // Finance already sees every family's invoice; being unable to write to the
    // parent whose debt they are chasing was the same gap. Pupils are not part
    // of that, and the split is deliberate.
    const bursar = who(ACCOUNTANT, ["accountant"]);
    expect(await canWrite(bursar, OTHER_PARENT)).toBe(true);
    expect(await canWrite(bursar, OTHER_PUPIL)).toBe(false);
  });

  it("a role with no family remit is unchanged — staff and teachers only", async () => {
    const librarian = who(LIBRARIAN, ["librarian"]);
    expect(await canWrite(librarian, TEACHER)).toBe(true);
    expect(await canWrite(librarian, MY_PUPIL)).toBe(false);
  });

  it("the compose list offers exactly what the send allows", async () => {
    // The two used to be separate expressions of one rule. A name in this list
    // that the send refuses is the bug that shape produces.
    const offered = await messaging.contacts(teacher());
    const ids = new Set(offered.map((c: { id: string }) => c.id));
    expect(ids.has(MY_PUPIL)).toBe(true);
    expect(ids.has(MY_PARENT)).toBe(true);
    expect(ids.has(OTHER_PUPIL)).toBe(false);
    expect(ids.has(OTHER_PARENT)).toBe(false);
    expect(ids.has(LEFT_PUPIL)).toBe(false);

    // And prove the correspondence rather than asserting it: everything offered
    // must actually be sendable.
    for (const id of ids) {
      expect(await canWrite(teacher(), id)).toBe(true);
    }
  });
});
