// =============================================================================
// Group console walkthrough — the operator and director journeys, end to end
// =============================================================================
// Every automated test of the group console was green, and driving it by hand
// still found five defects (a rounded zero read as "none", a PAID invoice that
// was owed, two refusals that said too little, a stale search answer). This
// replays that drive over HTTP against the RUNNING stack — nginx, the web, the
// API and the database together — so it can run after every change instead of
// once by hand:
//
//   operator  creates a group, adds schools (one bogus id), appoints directors
//             (a pupil, an unknown email and the principal) and reads what was
//             NOT applied; searches for candidates; renames the group
//   director  opens the console for every period and every campus page, and
//             the figures on each campus page must equal that campus's row;
//             the rendered pages must carry the period; downloads the CSV
//   operator  opens the ledger-integrity page; deletes the group
//
// It TOGGLES the Group Console module on the demo school (the director's
// school must have it) and RESTORES the school's modules afterwards, in a
// `finally`, so a failed run does not leave the demo changed.
//
// It does not click React controls — no browser runs here. The client-side
// behaviour (pickers, refresh-in-place) was driven in a real browser when it
// was built; this guards everything from the BFF down.
//
//   Usage:  node scripts/group-console-walkthrough.mjs
//   Env:    WEB_URL (default http://localhost), SMOKE_PASSWORD (default password123)
//   Needs:  the compose stack up with SEED_DEMO_DATA=true, and at least one
//           other customer school on the platform.
// Exit code is non-zero if any check fails.
// =============================================================================

import { WEB, makeClient, classify } from "./lib/stack-client.mjs";

const OWNER = "owner@sms.platform";
const DIRECTOR = "principal@demo.school";
const PUPIL = "student@demo.school";
const PERIODS = ["today", "week", "month", "term"];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

async function page(client, path) {
  const r = await client.get(path);
  const html = r.status === 200 ? await r.text() : "";
  return { status: r.status, html, verdict: classify(r.status, html) };
}

async function main() {
  console.log(`Group console walkthrough against ${WEB}\n`);
  const owner = makeClient();
  if (!check("operator signs in", await owner.login(OWNER))) return;

  // The director's OWN school, read from their session rather than guessed from
  // a name; tenant-names already leaves the platform's own organisation out.
  const probe = makeClient();
  if (!check("director signs in (to learn their school)", await probe.login(DIRECTOR))) return;
  const session = await (await probe.get("/api/auth/session")).json();
  const names = (await owner.api("/operator/tenant-names")) ?? [];
  const demo = names.find((n) => n.name === session?.user?.schoolName);
  const other = names.find((n) => n.id !== demo?.id);
  if (!check("found the demo school and one other", !!demo && !!other, `${demo?.name ?? "?"} + ${other?.name ?? "?"}`)) return;

  // The director's school must have the module. Remember exactly what it had.
  const subBefore = await owner.api(`/operator/tenants/${demo.id}/subscription`);
  if (!check("read the demo school's subscription", !!subBefore)) return;
  const original = { plan: subBefore.plan, overrides: { enabled: subBefore.overrides?.enabled ?? [], disabled: subBefore.overrides?.disabled ?? [] } };
  let groupId = null;

  try {
    if (!subBefore.modules.includes("group")) {
      const r = await owner.send("PUT", `/operator/tenants/${demo.id}/subscription`, {
        plan: original.plan,
        overrides: { enabled: [...new Set([...original.overrides.enabled, "group"])], disabled: original.overrides.disabled.filter((m) => m !== "group") },
      });
      if (!check("enabled the Group Console on the demo school (restored at the end)", r.status === 200, `HTTP ${r.status}`)) return;
    }

    // --- operator: build the group ------------------------------------------
    const created = await owner.send("POST", "/operator/groups", { name: `Walkthrough ${new Date().toISOString().slice(0, 19)}` });
    groupId = created.body?.id ?? null;
    if (!check("created a group", created.status === 201 && !!groupId, `HTTP ${created.status}`)) return;

    const bogus = "00000000-0000-4000-8000-0000000000ff";
    const members = await owner.send("PUT", `/operator/groups/${groupId}/members`, { schoolIds: [demo.id, other.id, bogus] });
    check(
      "members: two applied, the bogus id named as NOT applied",
      members.status === 200 && members.body.applied === 2 && members.body.notApplied.some((n) => n.value === bogus),
      JSON.stringify(members.body?.notApplied ?? members.body),
    );

    const directors = await owner.send("PUT", `/operator/groups/${groupId}/directors`, {
      emails: [DIRECTOR, PUPIL, "nobody-at-all@walkthrough.test"],
    });
    const why = Object.fromEntries((directors.body?.notApplied ?? []).map((n) => [n.value, n.reason]));
    check("directors: the principal appointed", directors.status === 200 && directors.body.applied === 1);
    check("directors: a PUPIL refused, with the reason", /pupil or a parent/.test(why[PUPIL] ?? ""), why[PUPIL]);
    check("directors: an unknown email refused, with the reason", /No account/.test(why["nobody-at-all@walkthrough.test"] ?? ""));

    const found = await owner.api(`/operator/groups/${groupId}/director-candidates?q=principal`);
    check("candidate search finds the principal", !!found?.rows?.some((r) => r.email === DIRECTOR) && found.total >= 1);
    const pupils = await owner.api(`/operator/groups/${groupId}/director-candidates?q=${encodeURIComponent(PUPIL)}`);
    check("candidate search never offers a pupil", pupils?.total === 0);

    const renamed = await owner.send("PATCH", `/operator/groups/${groupId}`, { name: "Walkthrough (renamed)" });
    check("renamed the group", renamed.status === 200);
    const listed = (await owner.api("/operator/groups")) ?? [];
    const mine = listed.find((g) => g.id === groupId);
    check("the group lists its director as able to open the console", mine?.directors?.[0]?.consoleEnabled === true);
    const groupsPage = await page(owner, "/operator/groups");
    check("/operator/groups renders", groupsPage.verdict === "ok" && groupsPage.status === 200, `HTTP ${groupsPage.status}`);

    // --- director: every period, every campus ---------------------------------
    // A FRESH sign-in: a school's modules ride the session from login, so the
    // probe session above predates the module being switched on.
    const director = makeClient();
    if (!check("director signs in", await director.login(DIRECTOR))) return;
    for (const period of PERIODS) {
      const q = `groupId=${groupId}&period=${period}`;
      const overview = await director.api(`/group/overview?${q}`);
      if (!check(`[${period}] overview answers`, !!overview && overview.period.key === period, overview ? "" : "null")) continue;
      check(`[${period}] overview lists both campuses`, overview.schools.length === 2);

      const board = await page(director, `/group?${q}`);
      check(`[${period}] /group renders`, board.verdict === "ok" && board.status === 200, `HTTP ${board.status}`);
      // The campus links carry the period — the defect that hid for longest.
      const link = new RegExp(`/group/${overview.schools[0].schoolId}\\?[^"]*period=${period}`);
      check(`[${period}] campus links carry the period`, link.test(board.html.replaceAll("&amp;", "&")));

      for (const row of overview.schools) {
        const detail = await director.api(`/group/schools/${row.schoolId}?period=${period}`);
        const same =
          !!detail &&
          detail.period.key === period &&
          detail.attendancePct === row.attendancePct &&
          detail.registersCovered === row.registersCovered &&
          detail.registersExpected === row.registersExpected &&
          JSON.stringify(detail.money) === JSON.stringify(row.money) &&
          JSON.stringify(detail.flags) === JSON.stringify(row.flags);
        check(`[${period}] ${row.name}: campus page equals its row`, same);
        const campus = await page(director, `/group/${row.schoolId}?${q}`);
        check(`[${period}] ${row.name}: campus page renders`, campus.verdict === "ok" && campus.status === 200, `HTTP ${campus.status}`);
      }
    }
    const csv = await director.get(`/api/sms/group/overview.csv?groupId=${groupId}&period=term`);
    const csvText = csv.status === 200 ? await csv.text() : "";
    check("CSV downloads with the coverage and overdue columns", /Registers covered/.test(csvText) && /Overdue/.test(csvText), `HTTP ${csv.status}`);

    // --- operator: the ledger check ---------------------------------------------
    const ledger = await page(owner, "/operator/ledger-integrity");
    check("/operator/ledger-integrity renders", ledger.verdict === "ok" && ledger.status === 200, `HTTP ${ledger.status}`);
    const mismatches = await owner.api("/operator/ledger-integrity");
    check("the ledger check answers with a total", typeof mismatches?.total === "number", `total ${mismatches?.total}`);
  } finally {
    // --- put everything back, whatever happened above ------------------------
    if (groupId) {
      const del = await owner.send("DELETE", `/operator/groups/${groupId}`);
      check("deleted the walkthrough group", del.status === 200, `HTTP ${del.status}`);
    }
    if (!subBefore.modules.includes("group")) {
      const r = await owner.send("PUT", `/operator/tenants/${demo.id}/subscription`, original);
      check("restored the demo school's modules", r.status === 200 && !r.body?.modules?.includes("group"), `HTTP ${r.status}`);
    }
  }
}

main()
  .catch((e) => check("walkthrough ran to the end", false, e?.stack ?? String(e)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    // A walkthrough that checked nothing must not read like a clean one.
    if (results.length < 10 || failed > 0) process.exit(1);
  });
