const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const NOTE_LIMIT = 350_000;
const SHARE_LIMIT = 350_000;
const MAX_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, name: "rapid-vimnote" });
      }

      if (url.pathname === "/api/notes/get" && request.method === "POST") {
        return getNote(request, env);
      }

      if (url.pathname === "/api/notes/put" && request.method === "PUT") {
        return putNote(request, env);
      }

      if (url.pathname === "/api/share" && request.method === "POST") {
        return createShare(request, env);
      }

      if (url.pathname.startsWith("/api/share/") && request.method === "GET") {
        return getShare(url, env);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: "internal_error", detail: error.message }, { status: 500 });
    }
  }
};

async function getNote(request, env) {
  const body = await readJson(request);
  assertId(body.topicId, "topicId");

  const row = await env.DB.prepare(
    "SELECT topic_id, body_cipher, iv, revision, created_at, updated_at FROM notes WHERE topic_id = ?"
  ).bind(body.topicId).first();

  if (!row) {
    return json({ found: false }, { status: 404 });
  }

  return json({
    found: true,
    topicId: row.topic_id,
    bodyCipher: row.body_cipher,
    iv: row.iv,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

async function putNote(request, env) {
  const body = await readJson(request);
  assertId(body.topicId, "topicId");
  assertCipher(body.bodyCipher, "bodyCipher", NOTE_LIMIT);
  assertId(body.iv, "iv");

  const knownRevision = Number.isInteger(body.knownRevision) ? body.knownRevision : 0;
  const force = body.force === true;
  const now = Date.now();

  const existing = await env.DB.prepare(
    "SELECT revision, body_cipher, iv, created_at, updated_at FROM notes WHERE topic_id = ?"
  ).bind(body.topicId).first();

  if (existing && existing.revision > knownRevision && !force) {
    return json({
      error: "conflict",
      server: {
        bodyCipher: existing.body_cipher,
        iv: existing.iv,
        revision: existing.revision,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at
      }
    }, { status: 409 });
  }

  const revision = existing ? existing.revision + 1 : 1;
  const createdAt = existing ? existing.created_at : now;

  await env.DB.prepare(
    `INSERT INTO notes (topic_id, body_cipher, iv, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET
       body_cipher = excluded.body_cipher,
       iv = excluded.iv,
       revision = excluded.revision,
       updated_at = excluded.updated_at`
  ).bind(body.topicId, body.bodyCipher, body.iv, revision, createdAt, now).run();

  return json({ ok: true, revision, updatedAt: now });
}

async function createShare(request, env) {
  const body = await readJson(request);
  assertId(body.topicId, "topicId");
  assertCipher(body.bodyCipher, "bodyCipher", SHARE_LIMIT);
  assertId(body.iv, "iv");
  if (body.shareKey !== undefined) {
    assertShareKey(body.shareKey);
  }
  if (body.shareSalt !== undefined) {
    assertShareSalt(body.shareSalt);
  }

  const ttlSeconds = clampTtl(body.ttlSeconds);
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const topicOrKey = body.shareSalt ? `pin:${body.shareSalt}` : body.shareKey ? `key:${body.shareKey}` : body.topicId;

  await cleanupExpiredShares(env, now);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomCode(5);
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO shares (token, topic_id, body_cipher, iv, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(token, topicOrKey, body.bodyCipher, body.iv, expiresAt, now).run();

    if ((result.meta?.changes || 0) > 0) {
      return json({ token, expiresAt, ttlSeconds });
    }
  }

  throw httpError("token_collision", 503);
}

async function getShare(url, env) {
  const token = url.pathname.slice("/api/share/".length);
  assertToken(token);

  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT token, topic_id, body_cipher, iv, expires_at, created_at FROM shares WHERE token = ?"
  ).bind(token).first();

  if (!row) {
    return json({ error: "not_found" }, { status: 404 });
  }

  if (row.expires_at <= now) {
    await env.DB.prepare("DELETE FROM shares WHERE token = ?").bind(token).run();
    return json({ error: "expired" }, { status: 410 });
  }

  const shareMeta = shareMetaFromTopic(row.topic_id);

  return json({
    token: row.token,
    bodyCipher: row.body_cipher,
    iv: row.iv,
    shareKey: shareMeta.shareKey,
    shareSalt: shareMeta.shareSalt,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  });
}

async function cleanupExpiredShares(env, now) {
  await env.DB.prepare("DELETE FROM shares WHERE expires_at <= ?").bind(now).run();
}

function clampTtl(value) {
  const ttl = Number.parseInt(value, 10);
  if (!Number.isFinite(ttl)) return 300;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, ttl));
}

async function readJson(request) {
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > NOTE_LIMIT + 4096) {
    throw httpError("payload_too_large", 413);
  }

  try {
    return await request.json();
  } catch {
    throw httpError("bad_json", 400);
  }
}

function assertId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw httpError(`invalid_${field}`, 400);
  }
}

function assertToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(value)) {
    throw httpError("invalid_token", 400);
  }
}

function assertShareKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw httpError("invalid_shareKey", 400);
  }
}

function assertShareSalt(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw httpError("invalid_shareSalt", 400);
  }
}

function assertCipher(value, field, limit) {
  if (typeof value !== "string" || value.length < 1 || value.length > limit) {
    throw httpError(`invalid_${field}`, 400);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw httpError(`invalid_${field}`, 400);
  }
}

function shareMetaFromTopic(value) {
  if (typeof value === "string" && value.startsWith("key:")) {
    return { shareKey: value.slice(4), shareSalt: "" };
  }

  if (typeof value === "string" && value.startsWith("pin:")) {
    return { shareKey: "", shareSalt: value.slice(4) };
  }

  return { shareKey: "", shareSalt: "" };
}

function randomCode(size) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) {
    token += alphabet[byte % alphabet.length];
  }
  return token;
}

function randomToken(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(),
      ...(init.headers || {})
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}
