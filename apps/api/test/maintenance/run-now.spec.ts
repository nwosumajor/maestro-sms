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
          // BOUNDED BY THE HANDLER, not by a byte count. A fixed window spans
          // into the NEXT route and vouches for its decorators — the trap this
          // repo has already been caught by. Cut at the method signature, which
          // is the first line after the decorators that does not start with `@`
          // or a comment.
          const from = src.indexOf(m[0]);
          const rest = src.slice(from);
          const end = rest.search(/\n  (?![@/*])[A-Za-z_]/);
          decorators = end === -1 ? rest.slice(0, 400) : rest.slice(0, end);
        }
      }
      expect({ job: j.key, routeFound: decorators !== null }).toEqual({ job: j.key, routeFound: true });

      // One permission or several — several mean ANY one of them opens the
      // route, which is how a CALLER job admits both the school officer whose
      // permission the catalogue names and the platform operator who runs the
      // fleet. The catalogue's permission must be among them.
      const members = [...decorators!.matchAll(/[A-Z_]+_PERMISSIONS\.([A-Z_]+)/g)]
        .map((m) => m[1])
        .filter((m) => byMember.has(m));
      const guardedBy = decorators!.includes("@RequirePermission(") ? members.map((m) => byMember.get(m)!) : [];
      expect({ job: j.key, guarded: guardedBy.length > 0 }).toEqual({ job: j.key, guarded: true });
      expect({ job: j.key, accepts: guardedBy.includes(j.manual.permission) }).toEqual({
        job: j.key,
        accepts: true,
      });
      // A second permission is only ever the platform operator's own.
      expect({ job: j.key, extra: guardedBy.filter((p) => p !== j.manual.permission) }).toEqual({
        job: j.key,
        extra: j.manual.scope === "CALLER" ? ["platform.operate"] : [],
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

  it("every job a school presses says where its control lives", () => {
    // Otherwise the console shows a dead end: no button and no next step. A
    // CALLER job needs it too — an operator gets a button, but everyone else
    // presses it from a page in their own school.
    for (const j of withManual) {
      if (j.manual.scope === "SCHOOL" || j.manual.scope === "CALLER") expect(j.manual.where).toBeTruthy();
    }
  });

  it("marks CALLER the sweeps whose permission is a school's but whose work is the fleet's", () => {
    const byKey = Object.fromEntries(withManual.map((j) => [j.key, j.manual.scope]));
    // Each of these ran the whole platform off a per-school permission. They are
    // not SCHOOL — an operator's press must still do the fleet, which is what
    // the button in this console is for — and not PLATFORM, because a principal
    // (or, for the delivery sweep, any teacher) can reach them.
    expect(byKey["privacy.archive"]).toBe("CALLER");
    expect(byKey["privacy.breachDeadline"]).toBe("CALLER");
    expect(byKey["notifications.deliveryRecovery"]).toBe("CALLER");
  });

  it("every job a school presses HAS a control on a screen", () => {
    // `where` is a claim, and a claim typed beside code rots. Six of these named
    // a page that had no button on it: the endpoint existed, the operator
    // console pointed at it, and a school had no way to press it. Driven by the
    // path, not by the prose — a screen counts only if it actually POSTs there.
    const web = join(__dirname, "../../../web");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".next") continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e)) files.push(readFileSync(full, "utf8"));
      }
    };
    walk(join(web, "components"));
    walk(join(web, "app"));
    expect(files.length).toBeGreaterThan(100); // a walk that found nothing proves nothing

    const missing = withManual
      .filter((j) => j.manual.scope !== "PLATFORM")
      // The WHOLE path, terminated. A bare `includes` matched
      // "hostels/exeats/overdue/runX" for "…/run" — a substring check vouches
      // for a neighbouring route, which is how a gate passes for the wrong
      // reason.
      .filter((j) => {
        const at = new RegExp(`${j.manual.path.replace(/[/]/g, "\\/")}(?=["'\`?])`);
        return !files.some((f) => at.test(f));
      })
      .map((j) => `${j.key} says its control is at "${j.manual.where}" but nothing there posts to /${j.manual.path}`);
    expect(missing).toEqual([]);
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

  it("offers Run now to whoever can actually do the work", () => {
    // SCHOOL is a dead end in this console and says so; PLATFORM and CALLER both
    // get a button, because an operator pressing a CALLER job runs the fleet.
    expect(ui).toMatch(/j\.manual\.scope === "SCHOOL"/);
    expect(ui).toMatch(/Run now/);
  });

  it("checks the permission before offering the button", () => {
    // The property, not the expression: the check moved into a `canPress`
    // helper when CALLER jobs arrived, because their catalogue permission is a
    // SCHOOL's and nobody on this console holds it — the operator was told
    // "Needs privacy.archive.manage" on their own console's button.
    expect(ui).toMatch(/hasPermission\(permissions, job\.manual\.permission as Permission\)/);
    expect(ui).toMatch(/scope === "CALLER" && hasPermission\(permissions, "platform\.operate"\)/);
  });

  it("refreshes the row after a run, so a successful sweep stops reading Late", () => {
    expect(ui).toMatch(/router\.refresh\(\)/);
  });

  it("shows the server's own reason when a run fails", () => {
    expect(ui).toMatch(/res\.error \?\? "It did not run\."/);
  });
});
