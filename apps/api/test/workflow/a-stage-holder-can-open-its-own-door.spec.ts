/**
 * A chain names somebody as an approver. Can they actually decide it?
 *
 * The stage permission (`workflow.review.head`) says WHOSE turn it is. The ROUTE
 * that performs the decision has its own gate, and the two are set in different
 * files — so a role can be named at a stage it cannot open, and the chain simply
 * stops. Nothing errors; the request sits there.
 *
 * This has now happened three times, in three chains:
 *
 *   head_teacher / content   fixed earlier; the role map records the reasoning
 *   head_admin   / content   found by driving a head admin's day — measured, the
 *                            IDENTICAL request: head teacher 201, head admin 403
 *   head_teacher / leave     could decide, but could see neither who else was
 *                            out nor which lessons the absence left uncovered
 *
 * The first two are this gate. The third is `an-approver-can-see-what-they-are-
 * deciding`, because being able to press the button is not the same as being
 * able to answer the question.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as T from "@sms/types";

const SRC = join(__dirname, "../../src");

/** Every controller route with the permissions it is gated on. */
function routes(): { method: string; path: string; perms: string[] }[] {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      statSync(p).isDirectory() ? walk(p) : e.endsWith(".controller.ts") && files.push(p);
    }
  })(SRC);
  const out: { method: string; path: string; perms: string[] }[] = [];
  const lookup = (ref: string) => {
    const m = ref.match(/^(\w+)\.(\w+)$/);
    if (!m) return null;
    const obj = (T as unknown as Record<string, Record<string, string>>)[m[1]];
    return obj && typeof obj === "object" ? obj[m[2]] ?? null : null;
  };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const ctrls = [...src.matchAll(/@Controller\((?:"([^"]*)")?\)/g)].map((m) => ({ i: m.index!, p: m[1] ?? "" }));
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\("([^"]*)"\)/g)) {
      const prefix = [...ctrls].reverse().find((c) => c.i < m.index!)?.p ?? "";
      const after = src.slice(m.index!, m.index! + 700);
      const perms = (after.match(/@RequirePermission\(([^)]*)\)/)?.[1] ?? "")
        .split(",").map((x) => x.trim()).filter(Boolean).map(lookup).filter(Boolean) as string[];
      out.push({ method: m[1].toUpperCase(), path: ("/" + [prefix, m[2]].filter(Boolean).join("/")).replace(/\/+/g, "/"), perms });
    }
  }
  return out;
}

/** Where each chain is actually decided. Most go through the engine; the ones
 *  with a door of their own are named, because that door has its own gate. */
const DOOR: Record<string, string> = {
  LMS_CONTENT_PUBLISH_CHAIN: "/content/:id/review",
  ADMISSION_REVIEW_CHAIN: "/admissions/:id/review",
};
const ENGINE = "/workflows/:id/review";

const chains = Object.entries(T as unknown as Record<string, unknown>).filter(
  ([n, v]) => n.endsWith("CHAIN") && Array.isArray(v) && v.length > 0 && (v[0] as { permission?: string })?.permission,
) as [string, { key: string; permission: string }[]][];

const holdersOf = (perm: string) =>
  Object.keys(T.ROLE_PERMISSIONS).filter((r) =>
    (T.ROLE_PERMISSIONS as Record<string, string[]>)[r].includes(perm));

describe("a stage-holder can open its own door", () => {
  const all = routes();

  it("found the chains and the routes — this gate must not pass by finding nothing", () => {
    expect(chains.length).toBeGreaterThanOrEqual(6);
    expect(all.length).toBeGreaterThan(400);
    expect(all.find((r) => r.path === ENGINE && r.method === "POST")).toBeTruthy();
  });

  it("every role named at a stage can perform that stage's decision", () => {
    const blind: string[] = [];
    for (const [name, chain] of chains) {
      const door = all.find((r) => r.path === (DOOR[name] ?? ENGINE) && r.method === "POST");
      expect(door).toBeTruthy();
      for (const stage of chain) {
        const roles = holdersOf(stage.permission);
        // A stage nobody holds is a dead end of a different kind, and
        // `assertChainCanBeDecided` is what catches that at runtime.
        expect(roles.length).toBeGreaterThan(0);
        for (const role of roles) {
          const held = (T.ROLE_PERMISSIONS as Record<string, string[]>)[role];
          const canOpen = door!.perms.length === 0 || door!.perms.some((p) => held.includes(p));
          if (!canOpen) blind.push(`${name}/${stage.key}: ${role} holds ${stage.permission} but not ${door!.perms.join("|")}`);
        }
      }
    }
    expect(blind).toEqual([]);
  });

  it("names a door for every chain that has one of its own", () => {
    // A chain whose door moves out from under this map would silently fall back
    // to the engine and be checked against the wrong gate.
    for (const path of Object.values(DOOR)) {
      expect(all.some((r) => r.path === path && r.method === "POST")).toBe(true);
    }
  });
});
