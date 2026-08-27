/**
 * The timetable solver is pure, and it was running inside the transaction.
 *
 * `generateTimetable` is a synchronous backtracking search with a 200,000-step
 * budget that touches no database. Running it inside `runAsTenant` spent the
 * 5-second interactive-transaction cap on arithmetic, and the bulk insert that
 * followed failed on an expired transaction.
 *
 * Measured live on the demo school's whole roll — 271 offerings, four lessons
 * each — the request answered HTTP 500 after 9.5 seconds:
 *
 *   Transaction already closed: the timeout for this transaction was 5000 ms,
 *   however 9322 ms passed since the start of the transaction
 *
 * So the flagship action of the module — generate a timetable for the school —
 * failed with an internal error, while three classes at a time succeeded in
 * 189 ms and hid it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/timetable/timetable.service.ts"), "utf8");
/**
 * The method, bounded to the NEXT member. My first version sliced to
 * `clearTimetable`, which does not exist — `indexOf` returned -1, the slice ran
 * to end of file, and the window swallowed three other methods that legitimately
 * use `runAsTenantReadOnly`. Mutating this method then changed nothing the test
 * could see. A window one scope too WIDE fails exactly like one too narrow, and
 * only mutation testing tells them apart.
 */
/**
 * COMMENTS STRIPPED FIRST. The note explaining this very fix mentions
 * `runAsTenantReadOnly`, so a search over the raw text found the SYMBOL IN THE
 * PROSE and every assertion passed with the read phase mutated back to a plain
 * transaction. This repo records gates that FAIL on the explanation of their own
 * fix; this is the same trap the other way round — prose making one PASS.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const START = CODE.indexOf("  async generate(");
const NEXT = CODE.indexOf("  async listUnavailability(", START);
const generate = CODE.slice(START, NEXT > START ? NEXT : CODE.length);

describe("a solve that spent the transaction", () => {
  it("found the method, and ONLY the method", () => {
    expect(generate).toMatch(/generateTimetable\(/);
    expect(generate.length).toBeGreaterThan(500);
    expect(NEXT).toBeGreaterThan(START); // the boundary really exists
    expect(generate).not.toMatch(/async listUnavailability/);
  });

  it("solves OUTSIDE any transaction", () => {
    // NESTING, not position. Ordering alone cannot tell "after the read
    // transaction" from "inside its callback" — the solve sits between the two
    // runAsTenant calls either way, and the mutation that put it back inside
    // passed a position-only assertion. The method body is indented four
    // spaces; anything inside a transaction callback is indented six or more.
    const line = generate.split("\n").find((l) => l.includes("const result = generateTimetable("));
    expect(line).toBeDefined();
    expect(line!.match(/^ */)![0].length).toBe(4);
  });

  it("opens a read phase and a separate write phase", () => {
    const readPhase = generate.indexOf("runAsTenantReadOnly");
    const writePhase = generate.indexOf("runAsTenant(this.ctx(p)", readPhase + 1);
    const solve = generate.indexOf("const result = generateTimetable(");
    expect(readPhase).toBeGreaterThan(-1);
    expect(solve).toBeGreaterThan(readPhase);
    expect(writePhase).toBeGreaterThan(solve);
  });

  it("keeps the delete and the insert in ONE transaction", () => {
    // The atomicity that actually matters: a partly-applied generation — old
    // lessons cleared, new ones not written — is worse than none. That never
    // needed the solve inside it.
    const writePhase = generate.slice(generate.indexOf("const result = generateTimetable("));
    const del = writePhase.indexOf("timetableEntry.deleteMany");
    const ins = writePhase.indexOf("createMany");
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    // ...and both after the write transaction opens.
    expect(writePhase.indexOf("runAsTenant(this.ctx(p)")).toBeLessThan(del);
  });

  it("still rejects the whole insert if the grid moved underneath it", () => {
    // The window is now the solve time rather than zero. The unique constraints
    // are what make that safe, and the P2002 translation is what makes it
    // legible — neither may be dropped as part of moving the solve.
    expect(generate).toMatch(/P2002/);
    expect(generate).toMatch(/nothing was saved/);
  });
});
