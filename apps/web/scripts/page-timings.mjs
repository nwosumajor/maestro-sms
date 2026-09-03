// How long does each page take to RENDER, for the role that actually uses it,
// at the volume this platform is meant to carry?
const WEB = process.env.WEB_URL ?? "http://localhost";
const PASSWORD = "password123";
const ROLES = process.env.SMOKE_ROLES.split(",").map(s => s.trim());
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function discover(dir, base = "") {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (!statSync(p).isDirectory()) { if (e === "page.tsx") out.push(base || "/"); continue; }
    if (e.startsWith("_")) continue;
    const seg = e.startsWith("(") && e.endsWith(")") ? "" : `/${e}`;
    out.push(...discover(p, base + seg));
  }
  return out;
}
const routes = [...new Set(discover(path.resolve("apps/web/app")))]
  .filter(r => !r.includes("[") && !r.startsWith("/api"))
  .sort();

async function login(email) {
  const jar = new Map();
  const put = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  let r = await fetch(`${WEB}/login`); put(r);
  r = await fetch(`${WEB}/api/auth/csrf`, { headers: { cookie: cookie() } }); put(r);
  const { csrfToken } = await r.json();
  r = await fetch(`${WEB}/api/auth/callback/credentials`, { method: "POST", redirect: "manual",
    headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }) });
  put(r);
  const s = await fetch(`${WEB}/api/auth/session`, { headers: { cookie: cookie() } });
  const j = await s.json().catch(() => ({}));
  return j?.user ? cookie() : null;
}

const rows = [];
for (const email of ROLES) {
  const cookie = await login(email);
  if (!cookie) { console.log("could not sign in:", email); continue; }
  for (const route of routes) {
    const t0 = Date.now();
    const res = await fetch(`${WEB}${route}`, { headers: { cookie }, redirect: "manual" });
    const ms = Date.now() - t0;
    await res.arrayBuffer();
    rows.push({ email, route, status: res.status, ms });
  }
  process.stdout.write(".");
}
console.log();
const shown = rows.filter(r => r.status === 200);
const byRoute = new Map();
for (const r of shown) { const a = byRoute.get(r.route) ?? []; a.push(r.ms); byRoute.set(r.route, a); }
const stats = [...byRoute].map(([route, ms]) => {
  ms.sort((a, b) => a - b);
  return { route, n: ms.length, med: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] };
}).sort((a, b) => b.max - a.max);
console.log(`rendered ${shown.length} pages (200) of ${rows.length} requests\n`);
console.log("SLOWEST 22 PAGES (ms)      med    max   n");
for (const s of stats.slice(0, 22)) console.log(`  ${s.route.padEnd(34)}${String(s.med).padStart(5)}${String(s.max).padStart(7)}${String(s.n).padStart(4)}`);
const all = shown.map(r => r.ms).sort((a, b) => a - b);
console.log(`\nall pages: median ${all[Math.floor(all.length/2)]}ms  p95 ${all[Math.floor(all.length*0.95)]}ms  max ${all[all.length-1]}ms`);
const nonOk = rows.filter(r => r.status >= 500);
console.log("5xx:", nonOk.length, nonOk.slice(0,5).map(r=>`${r.route}(${r.status})`).join(" "));
