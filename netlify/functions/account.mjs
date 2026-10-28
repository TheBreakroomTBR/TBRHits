// Customer API: POST /.netlify/functions/account  { action, ... }
// Reads only from the Netlify Blobs cache, so customer traffic never spends Airtable API calls.
import {
  json, store, normUser, getCache, hashPassword, checkPassword, signToken, verifyToken,
} from "../lib/shared.mjs";

const USER_RE = /^[a-z0-9._-]{2,40}$/;

function hitsFor(cache, username) {
  const strip = ({ id, username: _u, created, archivedAt, ...rest }) => ({ id, ...rest });
  return [...cache.active, ...cache.archive]
    .filter((h) => h.username === username)
    .map(strip)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.breakNo || 0) - (a.breakNo || 0));
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
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
      if (note.length < 3) return json({ error: "Tell us something we can check so we can approve you" }, 400);
      const key = `user:${username}`;
      if (await store().get(key)) return json({ error: "That username already has an account. Log in instead." }, 409);
      await store().setJSON(key, { username, ...hashPassword(password), note, approved: false, created: new Date().toISOString() });
      return json({ token: signToken(username), username, approved: false });
    }

    if (action === "login") {
      const username = normUser(body.username);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u || !checkPassword(body.password || "", u.salt, u.hash)) {
        return json({ error: "Username or password doesn't match" }, 401);
      }
      u.lastLogin = new Date().toISOString();
      await store().setJSON(`user:${username}`, u);
      return json({ token: signToken(username), username, mustChange: !!u.mustChange, approved: u.approved === true });
    }

    if (action === "me") {
      const username = verifyToken(body.token);
      if (!username) return json({ error: "Session expired, log in again" }, 401);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u) return json({ error: "Account not found, create it again" }, 401);
      if (u.approved !== true) return json({ username, pending: true, hits: [] });
      const cache = await getCache();
      return json({ username, hits: hitsFor(cache, username), updatedAt: cache.updatedAt || null });
    }

    if (action === "changePassword") {
      const username = verifyToken(body.token);
      if (!username) return json({ error: "Session expired, log in again" }, 401);
      const pw = String(body.password || "");
      if (pw.length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u) return json({ error: "Account not found" }, 404);
      Object.assign(u, hashPassword(pw), { mustChange: false });
      await store().setJSON(`user:${username}`, u);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
