// =============================================================================
// Six columns of encrypted staff PII, shipped to every HR reader
// =============================================================================
// Found by black-box probing: log in as seven roles, call all 175 parameterless
// GET routes, and grep every 200-JSON response for the schema's own sensitive
// column names. 395 responses came back and exactly one matched —
// `GET /hr/employees`:
//
//   "status":"ACTIVE","phoneEnc":null,"addressEnc":null,"nextOfKinEnc":null,
//   "nextOfKinPhoneEnc":null,"bankNameEnc":...
//
// The mapper was a DENY-LIST: it destructured out the three ciphertext columns
// it was written to know about (salary, TIN, RSA PIN), decrypted those, and
// spread `...rest`. The six field-encrypted self-service columns — phone,
// address, next of kin and their number, bank name, bank account — were added to
// the model in a later batch, and nobody came back here. So they rode out to
// every `hr.read` holder as raw ciphertext.
//
// The plaintext was never exposed; this is a real but bounded fault. What makes
// it worth fixing properly is the SHAPE: ciphertext of staff personal and bank
// data on the wire for no purpose (the client cannot read it), in a blob whose
// length still says something about the plaintext, on an endpoint that will keep
// leaking every encrypted column anyone adds in future.
//
// Those fields belong to `GET /hr/me`, which decrypts them for the one person
// they concern, and to the payroll bank export, which reads them directly. The
// sibling mapper in salary.service builds its DTO field by field — the pattern
// this one now matches, by rule rather than by list.
// =============================================================================

import { HrService } from "../../src/hr/hr.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const hr: Principal = {
  schoolId: "school-A",
  userId: "hr-1",
  roles: ["hr_manager"],
  permissions: ["hr.read", "hr.write"],
};

// A row shaped like the real table: plain columns, the three the mapper decrypts,
// and the six self-service ones it used to pass through.
const employeeRow = () => ({
  id: "emp-1",
  userId: "staff-1",
  schoolId: "school-A",
  jobTitle: "Teacher",
  department: "Science",
  status: "ACTIVE",
  startDate: new Date("2025-09-01T00:00:00.000Z"),
  endDate: null,
  salaryEnc: null,
  tinEnc: null,
  rsaPinEnc: null,
  phoneEnc: "v1:ciphertext-phone",
  addressEnc: "v1:ciphertext-address",
  nextOfKinEnc: "v1:ciphertext-kin",
  nextOfKinPhoneEnc: "v1:ciphertext-kin-phone",
  bankNameEnc: "v1:ciphertext-bank",
  bankAccountEnc: "v1:ciphertext-account",
});

function makeService(row: Record<string, unknown> = employeeRow()) {
  const tx = {
    employee: {
      findMany: jest.fn(async () => [row]),
      findFirst: jest.fn(async () => row),
    },
    user: { findMany: jest.fn(async () => [{ id: "staff-1", name: "A Teacher", email: "t@demo.school" }]) },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return new HrService(db as never, { record: jest.fn() } as never);
}

const CIPHERTEXT_COLUMNS = [
  "phoneEnc",
  "addressEnc",
  "nextOfKinEnc",
  "nextOfKinPhoneEnc",
  "bankNameEnc",
  "bankAccountEnc",
  "salaryEnc",
  "tinEnc",
  "rsaPinEnc",
];

describe("the employee list", () => {
  it("returns no ciphertext column at all", async () => {
    const rows = await makeService().listEmployees(hr);
    const keys = Object.keys(rows[0]);
    expect(keys.filter((k) => k.endsWith("Enc"))).toEqual([]);
  });

  it("names each one, so a regression says which", async () => {
    const rows = await makeService().listEmployees(hr);
    for (const col of CIPHERTEXT_COLUMNS) expect(rows[0]).not.toHaveProperty(col);
  });

  it("no ciphertext VALUE survives either, under any key", async () => {
    // Belt and braces: a future mapper could rename a field while still copying
    // the blob. Search the serialised response for the values themselves.
    const rows = await makeService().listEmployees(hr);
    expect(JSON.stringify(rows)).not.toMatch(/ciphertext-/);
  });

  it("still returns the fields HR actually works from", async () => {
    const rows = await makeService().listEmployees(hr);
    expect(rows[0]).toMatchObject({ id: "emp-1", jobTitle: "Teacher", status: "ACTIVE" });
    expect(rows[0].user).toMatchObject({ name: "A Teacher" });
  });

  it("still decrypts salary, TIN and RSA PIN", async () => {
    // The point of the endpoint. Narrowing what it returns must not break it.
    const rows = await makeService().listEmployees(hr);
    expect(rows[0]).toHaveProperty("salaryMinor");
    expect(rows[0]).toHaveProperty("tin");
    expect(rows[0]).toHaveProperty("rsaPin");
  });
});

describe("the single-employee read", () => {
  it("is clean too — it shares the mapper", async () => {
    const row = await makeService().getEmployee(hr, "staff-1");
    expect(Object.keys(row).filter((k) => k.endsWith("Enc"))).toEqual([]);
  });
});

describe("the rule, not the list", () => {
  it("drops an encrypted column nobody has thought of yet", async () => {
    // THE test. A list of six would pass while the next column added leaks; this
    // fails only if the mapper goes back to naming what it strips.
    const withNewColumn = { ...employeeRow(), passportNumberEnc: "v1:ciphertext-passport" };
    const rows = await makeService(withNewColumn).listEmployees(hr);
    expect(rows[0]).not.toHaveProperty("passportNumberEnc");
    expect(JSON.stringify(rows)).not.toContain("ciphertext-passport");
  });

  it("keeps a plain column whose name merely contains 'enc'", async () => {
    // The rule keys on the naming convention, so it must key on the END of the
    // name — "licence" and "reference" are not ciphertext.
    const withPlain = { ...employeeRow(), licence: "TRN-4491", reference: "REF-1" };
    const rows = await makeService(withPlain).listEmployees(hr);
    expect(rows[0]).toMatchObject({ licence: "TRN-4491", reference: "REF-1" });
  });
});
