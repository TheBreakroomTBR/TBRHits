// Shared helpers for the Helmet Hits functions.
// Airtable = source of truth for active hits.
// Netlify Blobs = read cache + archive + customer accounts (keeps Airtable calls/records low).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE = process.env.AIRTABLE_BASE_ID;
const AT_TABLE = process.env.AIRTABLE_TABLE || "Hits";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

export const STATUSES = ["In Fulfillment", "Shipped", "Buyback Hold"];
export const MONTHLY_CALL_LIMIT = 1000;   // Airtable Free plan
export const HARD_STOP_AT = 980;          // refuse new calls past this so you never hit the wall mid-stream
export const RECORD_LIMIT = 1000;         // Airtable Free plan, per base

export const store = () => getStore({ name: "helmet-hits", consistency: "strong" });

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const normUser = (u) =>
  String(u || "").trim().replace(/^@+/, "").toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const monthKey = () => new Date().toISOString().slice(0, 7);

// ---------- usage meter ----------
// Loaded once per invocation, counted in memory, written once at the end (flushUsage) to keep functions fast.
let usageMem = null;
export async function getUsage() {
  if (usageMem && usageMem.month === monthKey()) return usageMem;
  const u = await store().get("usage", { type: "json" });
  usageMem = !u || u.month !== monthKey() ? { month: monthKey(), calls: 0 } : u;
  usageMem._dirty = false;
  return usageMem;
}
async function bumpUsage() {
  const u = await getUsage();
  u.calls += 1;
  u._dirty = true;
}
export async function flushUsage() {
  if (usageMem && usageMem._dirty) {
    const { _dirty, ...clean } = usageMem;
    await store().setJSON("usage", clean);
    usageMem._dirty = false;
  }
  usageMem = null;
}

// ---------- Airtable ----------
async function at(method, query = "", body) {
  if (!AT_TOKEN || !AT_BASE) throw new Error("Airtable env vars missing (AIRTABLE_TOKEN / AIRTABLE_BASE_ID)");
  const usage = await getUsage();
  if (usage.calls >= HARD_STOP_AT) {
    throw new Error(`Airtable safety stop: ${usage.calls} calls used this month (free limit ${MONTHLY_CALL_LIMIT}). Resets on the 1st.`);
  }
  const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}${query}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await bumpUsage();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${AT_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(2500); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${data?.error?.message || data?.error?.type || "request failed"}`);
    return data;
  }
  throw new Error("Airtable rate limited, try again in a minute");
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export const fromAirtable = (r) => ({
  id: r.id,
  username: normUser(r.fields["Username"]),
  team: r.fields["Team"] || "",
  helmet: r.fields["Helmet"] || "",
  date: r.fields["Break Date"] || "",
  breakNo: r.fields["Break #"] ?? null,
  status: r.fields["Status"] || "In Fulfillment",
  tracking: r.fields["Tracking"] || "",
  created: r.createdTime,
});

const toFields = (h) => {
  const f = {};
  if (h.username !== undefined) f["Username"] = normUser(h.username);
  if (h.team !== undefined) f["Team"] = h.team;
  if (h.helmet !== undefined) f["Helmet"] = h.helmet;
  if (h.date !== undefined) f["Break Date"] = h.date || null;
  if (h.breakNo !== undefined) f["Break #"] = h.breakNo === "" || h.breakNo === null ? null : Number(h.breakNo);
  if (h.status !== undefined) f["Status"] = h.status;
  if (h.tracking !== undefined) f["Tracking"] = String(h.tracking || "").trim();
  return f;
};

export async function atListAll() {
  const all = [];
  let offset;
  do {
    const q = `?pageSize=100${offset ? `&offset=${offset}` : ""}`;
    const data = await at("GET", q);
    all.push(...data.records.map(fromAirtable));
    offset = data.offset;
    if (offset) await sleep(220);
  } while (offset);
  return all;
}

export async function atCreate(rows, out = []) {
  for (const batch of chunk(rows, 10)) {
    const data = await at("POST", "", { typecast: true, records: batch.map((h) => ({ fields: toFields(h) })) });
    out.push(...data.records.map(fromAirtable));
    await sleep(220);
  }
  return out;
}

export async function atUpdate(updates) {
  const out = [];
  for (const batch of chunk(updates, 10)) {
    const data = await at("PATCH", "", {
      typecast: true,
      records: batch.map((u) => ({ id: u.id, fields: toFields(u) })),
    });
    out.push(...data.records.map(fromAirtable));
    await sleep(220);
  }
  return out;
}

export async function atDelete(ids) {
  for (const batch of chunk(ids, 10)) {
    await at("DELETE", "?" + batch.map((id) => `records[]=${encodeURIComponent(id)}`).join("&"));
    await sleep(220);
  }
}

// ---------- cache ----------
export async function getCache() {
  const c = await store().get("cache", { type: "json" });
  return c || { active: [], archive: [], syncedAt: null };
}
export async function saveCache(c) {
  c.updatedAt = new Date().toISOString();
  await store().setJSON("cache", c);
  return c;
}

// ---------- passwords + sessions ----------
export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
export function checkPassword(pw, salt, hash) {
  const test = crypto.scryptSync(String(pw), salt, 64);
  const real = Buffer.from(hash, "hex");
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const b64u = (s) => Buffer.from(s).toString("base64url");
export function signToken(username, days = 60) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET env var missing");
  const payload = b64u(JSON.stringify({ u: username, exp: Date.now() + days * 864e5 }));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
export function verifyToken(token) {
  if (!token || !SESSION_SECRET) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.exp > Date.now() ? p.u : null;
  } catch { return null; }
}

// ---------- admin auth ----------
// The admin key is typed once per device and never stored in the browser.
// It's exchanged for a signed, HttpOnly cookie tied to a device record you can revoke.
const ADMIN_COOKIE = "gg_admin";
const LOCK_AFTER = 5;            // wrong keys in a row
const LOCK_MINUTES = 15;

const hmac = (data) => crypto.createHmac("sha256", "admin:" + SESSION_SECRET).update(data).digest("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clientIp = (req) => req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";

function readCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
export function adminCookie(token, maxAge = 31536000) {
  return `${ADMIN_COOKIE}=${token}; Path=/.netlify/functions/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function adminLogin(req, key, deviceName) {
  if (!process.env.ADMIN_KEY || !SESSION_SECRET) throw new Error("ADMIN_KEY / SESSION_SECRET env vars missing");
  const s = store();
  const lock = (await s.get("admin-lock", { type: "json" })) || { fails: 0, until: 0, log: [] };
  if (lock.until > Date.now()) {
    const mins = Math.ceil((lock.until - Date.now()) / 60000);
    return { error: `Too many wrong keys. Locked for ${mins} more minute${mins > 1 ? "s" : ""}.`, status: 429 };
  }
  if (!safeEq(key || "", process.env.ADMIN_KEY)) {
    lock.fails += 1;
    lock.log = [{ at: new Date().toISOString(), ip: clientIp(req) }, ...(lock.log || [])].slice(0, 20);
    if (lock.fails >= LOCK_AFTER) { lock.until = Date.now() + LOCK_MINUTES * 60000; lock.fails = 0; }
    await s.setJSON("admin-lock", lock);
    return { error: "Wrong admin key", status: 401 };
  }
  lock.fails = 0; lock.until = 0;
  await s.setJSON("admin-lock", lock);
  const id = crypto.randomBytes(9).toString("base64url");
  const device = {
    id, name: String(deviceName || "Unnamed device").slice(0, 60),
    created: new Date().toISOString(), lastSeen: new Date().toISOString(), ip: clientIp(req),
  };
  await s.setJSON(`admindev:${id}`, device);
  const payload = Buffer.from(JSON.stringify({ d: id, exp: Date.now() + 365 * 864e5 })).toString("base64url");
  return { token: `${payload}.${hmac(payload)}`, device };
}

// Returns the device record if the request carries a valid, unrevoked admin cookie.
export async function adminDevice(req) {
  const tok = readCookie(req, ADMIN_COOKIE);
  if (!tok || !SESSION_SECRET) return null;
  const [payload, sig] = tok.split(".");
  if (!payload || !sig || !safeEq(sig, hmac(payload))) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!p.d || p.exp < Date.now()) return null;
  const dev = await store().get(`admindev:${p.d}`, { type: "json" });
  if (!dev) return null; // revoked
  if (Date.now() - Date.parse(dev.lastSeen) > 3600e3) {
    dev.lastSeen = new Date().toISOString(); dev.ip = clientIp(req);
    await store().setJSON(`admindev:${p.d}`, dev);
  }
  return dev;
}
