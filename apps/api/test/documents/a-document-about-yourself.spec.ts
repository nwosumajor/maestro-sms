/**
 * A MEMBER OF STAFF'S OWN DOCUMENT.
 *
 * Owner's decision: staff may upload a document about themselves — a sick note,
 * a certificate, a doctor's report — to support a leave request, and the
 * PRINCIPAL, HR and the SCHOOL ADMINISTRATOR may read it.
 *
 * Before this the Vault could express two things: a document about a PUPIL, and
 * a school-level one that only school-wide staff may create or read. There was
 * no way to say "this is about me", so `leave_request.attachmentDocId` — which
 * requires a Vault document the CALLER uploaded — was unreachable for teacher,
 * hr_clerk, warden and librarian: most of the people who take leave.
 *
 * Measured live, one document:
 *   owner / principal / school_admin / HR manager / HR clerk  -> 200 + bytes
 *   accountant / another teacher                              -> 404
 *   principal REPLACING the bytes                             -> 404
 *   upload one ABOUT SOMEBODY ELSE                            -> 403
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@sms/types";

const SERVICE = readFileSync(
  join(__dirname, "..", "..", "src", "documents", "documents.service.ts"),
  "utf8",
);

describe("who may create one", () => {
  it("a staff member may, about themselves", () => {
    expect(SERVICE).toMatch(/if \(input\.staffUserId !== p\.userId\)/);
  });

  it("and about NOBODY else, senior or not", () => {
    // Uploading a document about another person is a different act — that is
    // what the student path and the HR record are for — so this is refused
    // even for staff-wide roles, who have their own routes.
    const create = SERVICE.slice(SERVICE.indexOf("async createDocument("), SERVICE.indexOf("async confirmUpload("));
    expect(create).toContain("You can only upload a document about yourself");
    expect(create).not.toMatch(/isStaffWide\(p\)[^\n]*staffUserId/);
  });

  it("refuses a document about a pupil AND a member of staff", () => {
    // Two subjects would make every read scope ambiguous.
    expect(SERVICE).toMatch(/input\.studentId && input\.staffUserId/);
  });
});

describe("who may read one", () => {
  it("the subject, and the roles the owner named", () => {
    expect(SERVICE).toMatch(/if \(p\.userId === subjectId\) return true;/);
    const readers = SERVICE.slice(
      SERVICE.indexOf("const STAFF_DOCUMENT_READERS"),
      SERVICE.indexOf("const STAFF_WIDE_ROLES"),
    );
    for (const role of ["principal", "school_admin", "hr_manager", "hr_clerk"]) {
      expect({ role, listed: readers.includes(`"${role}"`) }).toEqual({ role, listed: true });
    }
  });

  it("the HEAD TEACHER, who decides stage one of the leave chain", () => {
    // Added after the first version shipped without them: the chain is
    // head -> HR manager -> principal, so they are the FIRST to decide and were
    // approving without being able to open the evidence.
    const readers = SERVICE.slice(
      SERVICE.indexOf("const STAFF_DOCUMENT_READERS"),
      SERVICE.indexOf("const STAFF_WIDE_ROLES"),
    );
    expect(readers).toContain('"head_teacher"');
    expect((ROLE_PERMISSIONS.head_teacher as readonly string[])).toContain("document.read");
  });

  it("but NOT head_admin, who holds the same stage permission", () => {
    // The same situation one role over, left as a decision rather than
    // inferred: who reads a doctor's report is not something to widen by
    // analogy. Recorded here so it is visible rather than forgotten.
    const readers = SERVICE.slice(
      SERVICE.indexOf("const STAFF_DOCUMENT_READERS"),
      SERVICE.indexOf("const STAFF_WIDE_ROLES"),
    );
    expect(readers).not.toContain('"head_admin"');
  });

  it("NOT everyone who is staff-wide — accountant and board are not readers", () => {
    // A doctor's report is medical information about an adult. STAFF_WIDE_ROLES
    // includes accountant and board, who have no part in a leave decision.
    const readers = SERVICE.slice(
      SERVICE.indexOf("const STAFF_DOCUMENT_READERS"),
      SERVICE.indexOf("const STAFF_WIDE_ROLES"),
    );
    expect(readers).not.toContain("accountant");
    expect(readers).not.toContain("board");
  });

  it("refuses with 404, so a refusal is not an existence oracle", () => {
    const gate = SERVICE.slice(SERVICE.indexOf("private async requireVisible("), SERVICE.indexOf("private async visibleStudentIds("));
    expect(gate).toMatch(/canReadStaffDocument\(p, doc\.staffUserId\)\) throw new NotFoundException/);
  });

  it("HR actually holds the permission that reaches the route", () => {
    // The service rule is not enough on its own: `GET /documents/:id` requires
    // `document.read`, and hr_manager/hr_clerk held it for neither. Measured
    // live before the grant: HR manager got 403 at the guard, never reaching
    // the rule. // NOTE: a new grant only takes effect when the SEED RE-RUNS.
    for (const role of ["hr_manager", "hr_clerk"] as const) {
      expect({ role, has: (ROLE_PERMISSIONS[role] as readonly string[]).includes("document.read") })
        .toEqual({ role, has: true });
    }
  });
});

describe("who may write the bytes", () => {
  it("the owner alone — reading is not replacing", () => {
    const gate = SERVICE.slice(SERVICE.indexOf("private async requireWritable("), SERVICE.indexOf("private async requireVisible("));
    expect(gate).toMatch(/doc\.staffUserId !== p\.userId/);
    // Deliberately NOT the reader set: the principal may open a sick note and
    // must not be able to overwrite it.
    expect(gate).not.toContain("canReadStaffDocument");
  });

  it("through ONE gate, not a copy per path", () => {
    // `confirmUpload` and `uploadBytes` each hand-rolled the same two-arm check
    // and neither knew about a staff document, so a teacher could create their
    // own sick note and get 404 completing it. Three copies of one rule.
    for (const method of ["async uploadBytes(", "async confirmUpload("]) {
      const body = SERVICE.slice(SERVICE.indexOf(method), SERVICE.indexOf(method) + 900);
      expect(body).toContain("requireWritable");
    }
  });
});
