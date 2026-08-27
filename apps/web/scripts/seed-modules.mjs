// =============================================================================
// Seed the add-on modules with enough data to probe them
// =============================================================================
// permission-matrix.mjs cannot tell "this role was refused" from "this table is
// empty", and on a fresh database the library, hostel, transport, poll and
// discussion modules are all empty — so a run against them proves nothing. This
// fills them.
//
// THROUGH THE API, not SQL. The point is data the application itself would have
// created: real validation, real audit entries, real derived state. A direct
// INSERT can produce a row the app can never reach, which is worse than no data
// because a probe then passes against a shape that cannot occur.
//
// IDEMPOTENT WHERE THE APP LETS IT BE. Books carry a unique barcode, so a second
// run reports collisions and adds nothing — that is the app's own guard working.
// Hostels, routes and polls have no natural key, so re-running DOES duplicate
// them; everything is prefixed SEED so it can be found and removed.
//
// WARDENS AND DRIVERS ARE ASSIGNED at the end, and that is not decoration. Those
// two roles see only what they are assigned, so without it they read zero and a
// probe reports what looks like a dead grant — which is exactly what happened on
// the first run and cost a diagnosis.
//
// Usage (stack up, demo fixtures seeded):
//   WEB_URL=http://localhost pnpm --filter @sms/web seed:modules
// =============================================================================

// The compose stack is nginx on port 80; 3000 is the Next dev server. Same
// default trap the four probes carried — see isolation-probe.mjs.
const WEB = process.env.WEB_URL ?? "http://localhost";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "password123";
const AS = process.env.SEED_AS ?? "admin@demo.school";
const TAG = "SEED";

function client() {
  const jar = new Map();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  return {
    async login(email) {
      jar.clear();
      let r = await fetch(`${WEB}/api/auth/csrf`, { headers: { cookie: header() } });
      store(r);
      const { csrfToken } = await r.json();
      r = await fetch(`${WEB}/api/auth/callback/credentials`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }),
      });
      store(r);
      return [...jar.keys()].some((k) => k.includes("session-token"));
    },
    async call(method, path, body) {
      const res = await fetch(`${WEB}/api/sms/${path}`, {
        method, redirect: "manual",
        headers: { cookie: header(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let d = null;
      try { d = await res.json(); } catch { /* not json */ }
      return { status: res.status, d };
    },
  };
}

const main = async () => {
  const c = client();
  if (!(await c.login(AS))) {
    console.error(`could not sign in as ${AS} — is the stack up and seeded?`);
    process.exit(2);
  }
  const post = (p, b) => c.call("POST", p, b);
  const put = (p, b) => c.call("PUT", p, b);
  const get = (p) => c.call("GET", p);
  const ids = (r) => (Array.isArray(r.d) ? r.d : r.d?.items ?? []);
  const okCount = [];

  const pupils = ids(await get("students?q=Volume")).slice(0, 40).map((x) => x.id);
  if (pupils.length === 0) {
    console.error("no pupils found — seed the demo school first");
    process.exit(2);
  }

  // --- library ---------------------------------------------------------------
  const books = [];
  for (let i = 1; i <= 60; i++) {
    const r = await post("library/books", {
      title: `${TAG} Reader ${i}`, author: `Author ${i % 12}`,
      barcode: `${TAG}-${String(i).padStart(4, "0")}`,
      category: ["Fiction", "Science", "History", "Maths"][i % 4],
      totalCopies: 1 + (i % 4), customFields: {},
    });
    if (r.status < 400) books.push(r.d.id);
  }
  let loans = 0;
  for (let i = 0; i < Math.min(25, books.length, pupils.length); i++) {
    if ((await post("library/loans/issue", { bookId: books[i], borrowerId: pupils[i] })).status < 400) loans += 1;
  }
  okCount.push(`library: ${books.length} books, ${loans} loans`);

  // --- hostel ----------------------------------------------------------------
  const rooms = [];
  for (const [name, type] of [[`${TAG} Falcon House`, "BOYS"], [`${TAG} Heron House`, "GIRLS"], [`${TAG} Ibis House`, "MIXED"]]) {
    const h = await post("hostels", { name, type, customFields: {} });
    if (h.status >= 400) continue;
    for (let r = 1; r <= 4; r++) {
      const room = await post(`hostels/${h.d.id}/rooms`, {
        roomNumber: `${name.split(" ")[1][0]}${r}`, roomType: "SHARED", capacity: 6, rentMinor: 150_000, customFields: {},
      });
      if (room.status < 400) rooms.push(room.d.id);
    }
  }
  let beds = 0;
  for (let i = 0; i < Math.min(30, pupils.length); i++) {
    if (rooms.length && (await post("hostels/allocations", { roomId: rooms[i % rooms.length], studentId: pupils[i] })).status < 400) beds += 1;
  }
  okCount.push(`hostel: ${rooms.length} rooms, ${beds} boarders`);

  // --- transport -------------------------------------------------------------
  const routes = [];
  for (let v = 1; v <= 3; v++) {
    const veh = await post("transport/vehicles", { name: `${TAG} Bus ${v}`, regNumber: `${TAG}-${v}00`, capacity: 40, customFields: {} });
    if (veh.status >= 400) continue;
    const rt = await post("transport/routes", { name: `${TAG} Route ${v}`, vehicleId: veh.d.id, fareMode: "FLAT", flatFareMinor: 80_000, customFields: {} });
    if (rt.status < 400) routes.push(rt.d.id);
  }
  let seats = 0;
  for (let i = 0; i < Math.min(30, pupils.length); i++) {
    // passengerId + passengerType, NOT studentId — transport carries staff too.
    if (routes.length && (await post("transport/assignments", { routeId: routes[i % routes.length], passengerId: pupils[i], passengerType: "STUDENT" })).status < 400) seats += 1;
  }
  okCount.push(`transport: ${routes.length} routes, ${seats} seats`);

  // --- polls + discussion ----------------------------------------------------
  let polls = 0, groups = 0, posts = 0;
  for (const [question, audience] of [[`${TAG} Which trip?`, "ALL"], [`${TAG} New uniform colour?`, "STUDENTS"], [`${TAG} INSET day date?`, "STAFF"]]) {
    if ((await post("polls", { question, audience, options: ["Option A", "Option B", "Option C"] })).status < 400) polls += 1;
  }
  for (const [name, audience] of [[`${TAG} Notice Board`, "ALL"], [`${TAG} Year Group Chat`, "STUDENTS"], [`${TAG} Staff Room`, "STAFF"]]) {
    const g = await post("discussion/groups", { name, audience });
    if (g.status >= 400) continue;
    groups += 1;
    for (let i = 1; i <= 4; i++) {
      if ((await post(`discussion/groups/${g.d.id}/posts`, { body: `${TAG} post ${i} in ${name}` })).status < 400) posts += 1;
    }
  }
  okCount.push(`polls: ${polls}, discussion: ${groups} groups / ${posts} posts`);

  // --- assign the relationship-scoped roles ----------------------------------
  // Without this, warden and driver read zero from a fully-populated module and
  // a probe cannot tell that from a broken grant.
  const staff = ids(await get("users?kind=staff"));
  const wardenId = staff.find((u) => u.email === "warden@demo.school")?.id;
  const driverId = staff.find((u) => u.email === "driver@demo.school")?.id;
  let assigned = 0;
  if (wardenId) for (const h of ids(await get("hostels")).slice(0, 3)) {
    if ((await put(`hostels/${h.id}`, { wardenId })).status < 400) assigned += 1;
  }
  if (driverId) for (const v of ids(await get("transport/vehicles")).slice(0, 3)) {
    if ((await put(`transport/vehicles/${v.id}`, { driverId })).status < 400) assigned += 1;
  }
  okCount.push(`assigned ${assigned} hostel(s)/vehicle(s) to the warden and driver`);

  for (const line of okCount) console.log(`  ${line}`);
  console.log(`\nAll rows are prefixed "${TAG}". To remove: delete rows whose name/title/question begins with it.`);
};

main().catch((e) => { console.error(e); process.exit(2); });
