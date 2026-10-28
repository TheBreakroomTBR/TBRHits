// Customer API: POST /.netlify/functions/account  { action, ... }
// Reads only from the Netlify Blobs cache, so customer traffic never spends Airtable API calls.
import {
  json, store, normUser, getCache, hashPassword, checkPassword, signToken, verifyToken,
} from "../lib/shared.mjs";

// A token only counts for the account it was issued to: if the account was deleted and re-created, old tokens die.
async function sessionUser(token) {
  const t = verifyToken(token);
  if (!t) return null;
  const u = await store().get(`user:${t.username}`, { type: "json" });
  if (!u || t.iat < Date.parse(u.created) || (u.pwChangedAt && t.iat < Date.parse(u.pwChangedAt) - 1000)) return null;
  return u;
}

const USER_RE = /^[a-z0-9._-]{2,40}$/;

const byNewest = (a, b) => (b.date || "").localeCompare(a.date || "") || (b.breakNo || 0) - (a.breakNo || 0);

// Public board: no tracking, no account links.
function boardRows(cache) {
  return [...cache.active, ...cache.archive]
    .map(({ id, username, team, helmet, date, breakNo, status }) => ({ id, username, team, helmet, date, breakNo, status }))
    .sort(byNewest);
}

// Only hits you've assigned to this account, with tracking.
function hitsFor(cache, username) {
  return [...cache.active, ...cache.archive]
    .filter((h) => h.assignedTo === username)
    .map(({ id, username: buyer, team, helmet, date, breakNo, status, tracking }) => ({ id, buyer, team, helmet, date, breakNo, status, tracking }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.breakNo || 0) - (a.breakNo || 0));
}

export default async (req) => {
  // Public hit list. Cached at Netlify's CDN for 60s so a busy stream doesn't run the function per viewer.
  if (req.method === "GET") {
    const cache = await getCache();
    return new Response(JSON.stringify({ hits: boardRows(cache), updatedAt: cache.updatedAt || null }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=0, must-revalidate",
        "netlify-cdn-cache-control": "public, durable, s-maxage=60, stale-while-revalidate=300",
      },
    });
  }
  if (req.method !== "POST") return json({ error: "GET or POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { action } = body;

  try {
    if (action === "signup") {
      const username = normUser(body.username);
      const password = String(body.password || "");
      if (!USER_RE.test(username)) return json({ error: "Use the exact username you buy under (letters, numbers, . _ -)" }, 400);
      if (password.length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
      const note = String(body.note || "").trim().slice(0, 200);
      if (note.length < 3) return json({ error: "Add your last hit or order # so we can match your helmets to you" }, 400);
      const key = `user:${username}`;
      if (await store().get(key)) return json({ error: "That username already has an account. Log in instead." }, 409);
      await store().setJSON(key, { username, ...hashPassword(password), note, created: new Date().toISOString() });
      return json({ token: signToken(username), username });
    }

    if (action === "login") {
      const username = normUser(body.username);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u || !checkPassword(body.password || "", u.salt, u.hash)) {
        return json({ error: "Username or password doesn't match" }, 401);
      }
      u.lastLogin = new Date().toISOString();
      await store().setJSON(`user:${username}`, u);
      return json({ token: signToken(username), username, mustChange: !!u.mustChange });
    }

    if (action === "me") {
      const u = await sessionUser(body.token);
      if (!u) return json({ error: "Session expired, log in again" }, 401);
      const cache = await getCache();
      return json({ username: u.username, hits: hitsFor(cache, u.username), updatedAt: cache.updatedAt || null });
    }

    if (action === "changePassword") {
      const u = await sessionUser(body.token);
      if (!u) return json({ error: "Session expired, log in again" }, 401);
      const pw = String(body.password || "");
      if (pw.length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
      Object.assign(u, hashPassword(pw), { mustChange: false });
      await store().setJSON(`user:${u.username}`, u);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
