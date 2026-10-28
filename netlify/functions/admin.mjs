// Admin API: POST /.netlify/functions/admin  { action, ... }  auth: HttpOnly session cookie from action "login"
import {
  json, store, adminLogin, adminDevice, adminCookie, normUser, STATUSES, RECORD_LIMIT, MONTHLY_CALL_LIMIT,
  getCache, saveCache, getUsage, flushUsage,
  atListAll, atCreate, atUpdate, atDelete, hashPassword,
} from "../lib/shared.mjs";
import crypto from "node:crypto";

async function snapshot(cache) {
  const u = await getUsage();
  return {
    active: cache.active,
    archive: cache.archive,
    syncedAt: cache.syncedAt,
    updatedAt: cache.updatedAt,
    usage: { month: u.month, calls: u.calls, limit: MONTHLY_CALL_LIMIT },
    records: { used: cache.active.length, limit: RECORD_LIMIT },
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const { action } = body;

  // ---- sign in (the only action that works without a session) ----
  if (action === "login") {
    try {
      const out = await adminLogin(req, body.key, body.device);
      if (out.error) return json({ error: out.error }, out.status);
      const res = json({ ok: true, device: out.device });
      res.headers.append("set-cookie", adminCookie(out.token));
      return res;
    } catch (e) { return json({ error: e.message }, 500); }
  }

  const me = await adminDevice(req);
  if (!me) return json({ error: "Not signed in" }, 401);

  try {
    if (action === "session") return json({ ok: true, device: me });

    if (action === "logout") {
      await store().delete(`admindev:${me.id}`);
      const res = json({ ok: true });
      res.headers.append("set-cookie", adminCookie("x", 0));
      return res;
    }

    // ---- signed-in devices ----
    if (action === "devices") {
      const { blobs } = await store().list({ prefix: "admindev:" });
      const devices = [];
      for (const b of blobs) { const d = await store().get(b.key, { type: "json" }); if (d) devices.push({ ...d, current: d.id === me.id }); }
      devices.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      const lock = (await store().get("admin-lock", { type: "json" })) || {};
      return json({ devices, failedAttempts: lock.log || [], lockedUntil: lock.until > Date.now() ? lock.until : null });
    }
    if (action === "revokeDevice") {
      await store().delete(`admindev:${body.id}`);
      return json({ ok: true });
    }
    if (action === "revokeOthers") {
      const { blobs } = await store().list({ prefix: "admindev:" });
      for (const b of blobs) if (b.key !== `admindev:${me.id}`) await store().delete(b.key);
      return json({ ok: true });
    }

    // ---- read (0 Airtable calls) ----
    if (action === "list") {
      return json(await snapshot(await getCache()));
    }

    // ---- pull everything from Airtable (use after editing in Airtable directly) ----
    if (action === "sync") {
      const cache = await getCache();
      cache.active = await atListAll();
      cache.syncedAt = new Date().toISOString();
      await saveCache(cache);
      return json(await snapshot(cache));
    }

    // ---- add a break's results ----
    if (action === "add") {
      const rows = (body.rows || [])
        .map((r) => ({
          username: normUser(r.username),
          team: String(r.team || "").trim(),
          helmet: String(r.helmet || "").trim(),
          date: r.date || "",
          breakNo: r.breakNo ?? "",
          status: STATUSES.includes(r.status) ? r.status : "In Fulfillment",
          tracking: r.tracking || "",
        }))
        .filter((r) => r.username && r.team);
      if (!rows.length) return json({ error: "No valid rows (each needs a username and team)" }, 400);
      if (rows.length > 60) return json({ error: "Send 60 rows or fewer per request" }, 400);

      const cache = await getCache();
      if (cache.active.length + rows.length > RECORD_LIMIT) {
        return json({ error: `That would put Airtable over ${RECORD_LIMIT} records. Archive shipped hits first.` }, 400);
      }
      const created = [];
      try {
        await atCreate(rows, created);
      } finally {
        // keep the cache in step even if a batch fails partway
        if (created.length) { cache.active.push(...created); await saveCache(cache); }
      }
      return json(await snapshot(cache));
    }

    // ---- update status / tracking / fields ----
    if (action === "update") {
      const updates = (body.updates || []).filter((u) => u.id);
      for (const u of updates) {
        if (u.status !== undefined && !STATUSES.includes(u.status)) return json({ error: `Bad status: ${u.status}` }, 400);
      }
      if (!updates.length) return json({ error: "Nothing to update" }, 400);
      const cache = await getCache();
      const changed = await atUpdate(updates);
      const byId = new Map(changed.map((r) => [r.id, r]));
      cache.active = cache.active.map((r) => byId.get(r.id) || r);
      await saveCache(cache);
      return json(await snapshot(cache));
    }

    // ---- delete mistakes ----
    if (action === "delete") {
      const ids = body.ids || [];
      if (!ids.length) return json({ error: "No ids" }, 400);
      const cache = await getCache();
      await atDelete(ids);
      const gone = new Set(ids);
      cache.active = cache.active.filter((r) => !gone.has(r.id));
      await saveCache(cache);
      return json(await snapshot(cache));
    }

    // ---- archive: move hits out of Airtable (frees records) but keep them visible to customers ----
    if (action === "archive") {
      const cache = await getCache();
      const want = new Set(body.ids || []);
      const moving = cache.active.filter((r) => want.has(r.id) && r.status === "Shipped");
      if (!moving.length) return json({ error: "Only Shipped hits can be archived" }, 400);
      await atDelete(moving.map((r) => r.id));
      const movedIds = new Set(moving.map((r) => r.id));
      cache.active = cache.active.filter((r) => !movedIds.has(r.id));
      cache.archive.push(...moving.map((r) => ({ ...r, archivedAt: new Date().toISOString() })));
      await saveCache(cache);
      return json(await snapshot(cache));
    }

    // ---- customer accounts ----
    if (action === "accounts") {
      const cache = await getCache();
      const counts = {};
      for (const h of [...cache.active, ...cache.archive]) counts[h.username] = (counts[h.username] || 0) + 1;
      const { blobs } = await store().list({ prefix: "user:" });
      const users = [];
      for (const b of blobs) {
        const u = await store().get(b.key, { type: "json" });
        if (u) users.push({
          username: u.username, created: u.created, lastLogin: u.lastLogin || null,
          approved: u.approved === true, approvedAt: u.approvedAt || null, note: u.note || "",
          hits: counts[u.username] || 0,
        });
      }
      users.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      return json({ users });
    }

    if (action === "approveAccount" || action === "unapproveAccount") {
      const username = normUser(body.username);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u) return json({ error: "No account with that username" }, 404);
      u.approved = action === "approveAccount";
      u.approvedAt = u.approved ? new Date().toISOString() : null;
      await store().setJSON(`user:${username}`, u);
      return json({ ok: true });
    }

    if (action === "resetPassword") {
      const username = normUser(body.username);
      const u = await store().get(`user:${username}`, { type: "json" });
      if (!u) return json({ error: "No account with that username" }, 404);
      const temp = crypto.randomBytes(4).toString("hex"); // 8 chars
      Object.assign(u, hashPassword(temp), { mustChange: true });
      await store().setJSON(`user:${username}`, u);
      return json({ username, tempPassword: temp });
    }

    if (action === "deleteAccount") {
      const username = normUser(body.username);
      await store().delete(`user:${username}`);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  } finally {
    await flushUsage().catch(() => {});
  }
};
