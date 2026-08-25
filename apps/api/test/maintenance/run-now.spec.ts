// =============================================================================
// Running a sweep by hand, and having that count
// =============================================================================
// The jobs console could say a sweep was LATE and offer nothing to do about it.
// The three that matter most had no control anywhere in the web at all —
// dunning (charges saved cards, flips lapsed subscriptions), payment
// reconciliation (recovers charges a lost webhook dropped) and mobile-money
// recovery (the ONLY thing that closes an intent when an unsigned callback never
// arrives). Triggering any of them meant curl.
//
// And a second defect, in the console I built: `JobRunsService.record` took a
// trigger of SCHEDULE | MANUAL, there was a unit test asserting MANUAL was
// stored — and not one caller ever passed it. Every manual endpoint called its
// service directly, so a hand-run left no trace: you could run dunning, and the
// console would still say it had not run since yesterday. The parameter existed,
// the test passed, and the behaviour was absent. (The same shape as the grading
// policy that no read path passed.)
//
// The scope split is the part worth protecting. A PLATFORM sweep is cross-tenant
// and privileged, so pressing it does what the timer does. A SCHOOL sweep runs
// inside ONE tenant — pressed from the operator console it would sweep the
// PLATFORM's own org, find nothing, and report success. A button that lies is
// worse than no button, so those are labelled with where their control lives.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { controllerPrefixAt } from "../support/api-routes";
import * as types from "@sms/types";
import { SCHEDULED_JOBS } from "../../src/maintenance/job-runs.service";

const SRC = join(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

const CONTROLLERS = walk(SRC).map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

/** Every routable POST path in the app, as `prefix/route`. */
function allPostPaths(): Set<string> {
  const paths = new Set<string>();
  for (const { src } of CONTROLLERS) {
    for (const m of src.matchAll(/@Post\("([^"]*)"\)/g)) {
      paths.add([controllerPrefixAt(src, m.index!), m[1]].filter(Boolean).join("/"));
    }
    // A bare @Post() serves the controller's own path. Each occurrence resolves
    // against its own controller — the original took the file's first one, and
    // a file may declare two.
    for (const m of src.matchAll(/@Post\(\)/g)) {
      const at = controllerPrefixAt(src, m.index!);
      if (at) paths.add(at);
    }
  }
  return paths;
}

const withManual = SCHEDULED_JOBS.filter(
  (j): j is typeof j & { manual: { path: string; permission: string; scope: string; where?: string } } =>
    "manual" in j,
);

describe("the catalogue cannot name an endpoint that does not exist", () => {
  const posts = allPostPaths();

  it.each(withManual.map((j) => [j.key, j.manual.path]))(
    "%s -> POST /%s is a real route",
    (_key, path) => {
      expect(posts.has(path as string)).toBe(true);
    },
  );

  it("names the permission the route actually requires", () => {
    // A button rendered on a permission the endpoint does not check would show
    // for people it then 403s — the picker/guard divergence, in another shape.
    //
    // Resolve the decorator's CONSTANT to its string value rather than guessing
    // the member name from the permission: the two do not always match
    // (`privacy.archive.manage` is exported as ARCHIVE_MANAGE), and a test that
    // guessed would fail on naming rather than on the thing it cares about.
    const byMember = new Map<string, string>();
    for (const [name, group] of Object.entries(types as Record<string, unknown>)) {
      if (!name.endsWith("_PERMISSIONS") || typeof group !== "object" || !group) continue;
      for (const [member, value] of Object.entries(group as Record<string, unknown>)) {
        if (typeof value === "string") byMember.set(member, value);
      }
    }

    for (const j of withManual) {
      let decorators: string | null = null;
      for (const { src } of CONTROLLERS) {
        for (const m of src.matchAll(/@Post\("([^"]*)"\)/g)) {
          const prefix = controllerPrefixAt(src, m.index!);
          if ([prefix, m[1]].filter(Boolean).join("/") !== j.manual.path) continue;
          const from = src.indexOf(m[0]);
          decorators = src.slice(from, from + 400);
        }
      }
      expect({ job: j.key, routeFound: decorators !== null }).toEqual({ job: j.key, routeFound: true });

      const member = decorators!.match(/@RequirePermission\([A-Z_]+_PERMISSIONS\.([A-Z_]+)\)/)?.[1];
      expect({ job: j.key, guarded: member !== undefined }).toEqual({ job: j.key, guarded: true });
      expect({ job: j.key, permission: byMember.get(member!) }).toEqual({
        job: j.key,
        permission: j.manual.permission,
      });
    }
  });
});

describe("every job that can be run by hand records that it was", () => {
  it.each(withManual.map((j) => [j.key]))("%s wraps its handler in record(..., MANUAL)", (key) => {
    const found = CONTROLLERS.some(({ src }) =>
      src.includes(`this.jobRuns.record("${key}", "MANUAL"`),
    );
    expect(found).toBe(true);
  });

  it("the recorded key matches the catalogue key exactly", () => {
    // A typo here is silent: the run is recorded under a key the console does
    // not list, so the row still reads "never run" after a successful sweep.
    const keys = new Set(SCHEDULED_JOBS.map((j) => j.key as string));
    for (const { src } of CONTROLLERS) {
      for (const m of src.matchAll(/this\.jobRuns\.record\("([^"]+)", "MANUAL"/g)) {
        expect(keys).toContain(m[1]);
      }
    }
  });

  it("does not double-record: a scheduler records SCHEDULE, a controller MANUAL", () => {
    // The processor calls the SERVICE, never the controller, so the two paths
    // record once each. If a controller ever recorded SCHEDULE, a hand-run would
    // masquerade as evidence that the timer is alive — the exact question this
    // console exists to answer.
    for (const { src } of CONTROLLERS) {
      expect(src).not.toMatch(/this\.jobRuns\.record\("[^"]+", "SCHEDULE"/);
    }
  });
});

describe("scope", () => {
  it("marks cross-tenant sweeps PLATFORM and tenant sweeps SCHOOL", () => {
    const byKey = Object.fromEntries(withManual.map((j) => [j.key, j.manual.scope]));
    // The money sweeps: privileged, cross-tenant, and the whole reason for the
    // button. If one of these ever becomes SCHOOL the console silently stops
    // offering it.
    expect(byKey["billing.dunning"]).toBe("PLATFORM");
    expect(byKey["fees.reconciliation"]).toBe("PLATFORM");
    expect(byKey["payments.mobileMoneyRecovery"]).toBe("PLATFORM");
    // Tenant-scoped: pressing these from the operator console would sweep the
    // platform's own org and report nothing found.
    expect(byKey["integrity.retention"]).toBe("SCHOOL");
    expect(byKey["fees.ops"]).toBe("SCHOOL");
    expect(byKey["hostel.exeatOverdue"]).toBe("SCHOOL");
  });

  it("every SCHOOL-scoped job says where its control lives", () => {
    // Otherwise the console shows a dead end: no button and no next step.
    for (const j of withManual) {
      if (j.manual.scope === "SCHOOL") expect(j.manual.where).toBeTruthy();
    }
  });

  it("the one job with no manual trigger is the partition roll", () => {
    const noManual = SCHEDULED_JOBS.filter((j) => !("manual" in j)).map((j) => j.key);
    expect(noManual).toEqual(["maintenance.auditPartition"]);
  });
});

describe("the console renders the split", () => {
  const ui = readFileSync(
    join(__dirname, "../../../web/components/operator/JobsTable.tsx"),
    "utf8",
  );

  it("offers Run now only for PLATFORM scope", () => {
    expect(ui).toMatch(/j\.manual\.scope === "SCHOOL"/);
    expect(ui).toMatch(/Run now/);
  });

  it("checks the permission before offering the button", () => {
    expect(ui).toMatch(/hasPermission\(permissions, j\.manual\.permission as Permission\)/);
  });

  it("refreshes the row after a run, so a successful sweep stops reading Late", () => {
    expect(ui).toMatch(/router\.refresh\(\)/);
  });

  it("shows the server's own reason when a run fails", () => {
    expect(ui).toMatch(/res\.error \?\? "It did not run\."/);
  });
});
