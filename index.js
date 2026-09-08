const SQUARE_API_VERSION = "2026-08-19";
let schemaPromise;

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);

      if (url.pathname === "/api/config" && request.method === "GET") {
        return getPublicConfig(env);
      }

      if (url.pathname === "/api/apps" && request.method === "GET") {
        return listApps(env, false);
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        return createSession(request, env);
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        return getMe(request, env);
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return logout(request, env);
      }

      if (url.pathname === "/api/access/start" && request.method === "POST") {
        return startAccess(request, env);
      }

      if (url.pathname === "/api/access/check" && request.method === "GET") {
        return checkAccess(request, env, url);
      }

      if (url.pathname === "/api/sandbox-payment" && request.method === "POST") {
        return sandboxPayment(request, env);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return adminLogin(request, env);
      }

      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        return adminLogout(request, env);
      }

      if (url.pathname === "/api/admin/password" && request.method === "POST") {
        await requireAdmin(request, env);
        return changeAdminPassword(request, env);
      }

      if (url.pathname === "/api/admin/apps" && request.method === "GET") {
        await requireAdmin(request, env);
        return listApps(env, true);
      }

      if (url.pathname === "/api/admin/apps" && request.method === "POST") {
        await requireAdmin(request, env);
        return saveApp(request, env);
      }

      if (url.pathname.startsWith("/api/admin/apps/") && request.method === "DELETE") {
        await requireAdmin(request, env);
        return disableApp(url.pathname.split("/").pop(), env);
      }

      if (url.pathname === "/api/admin/square-settings" && request.method === "GET") {
        await requireAdmin(request, env);
        return getSquareSettings(env);
      }

      if (url.pathname === "/api/admin/square-settings" && request.method === "POST") {
        await requireAdmin(request, env);
        return saveSquareSettings(request, env);
      }

      if (url.pathname === "/api/admin/square-test" && request.method === "POST") {
        await requireAdmin(request, env);
        return squareConnectionTest(env);
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        await requireAdmin(request, env);
        return listUsers(env);
      }

      if (url.pathname === "/api/admin/access" && request.method === "POST") {
        await requireAdmin(request, env);
        return adminSetAccess(request, env);
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          d1: !!env.DB,
          r2: !!env.BUCKET,
          square_token_secret: !!env.SQUARE_ACCESS_TOKEN
        });
      }

      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      console.error(e);
      return json(
        {
          error: e?.message || "SERVER_ERROR",
          detail: e?.detail || undefined
        },
        e?.status || 500
      );
    }
  }
};

async function ensureSchema(env) {
  if (!env.DB) throw httpError(500, "D1 binding「DB」がありません");

  if (!schemaPromise) {
    schemaPromise = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        billing_mode TEXT NOT NULL DEFAULT 'free',
        trial_days INTEGER NOT NULL DEFAULT 0,
        monthly_price INTEGER NOT NULL DEFAULT 0,
        paid_days INTEGER NOT NULL DEFAULT 30,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        square_customer_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_access (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'trialing',
        trial_started_at TEXT,
        trial_ends_at TEXT,
        active_until TEXT,
        square_subscription_id TEXT,
        next_billing_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, app_id)
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_payments (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        app_id TEXT,
        square_payment_id TEXT,
        amount INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'JPY',
        status TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'sandbox',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_admin_auth (
        id TEXT PRIMARY KEY,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        iterations INTEGER NOT NULL DEFAULT 210000,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),

      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pay2_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TEXT
      )`)
    ]).then(async () => {
      const appColumns = await env.DB.prepare("PRAGMA table_info(pay2_apps)").all();
      if (!(appColumns.results || []).some((c) => c.name === "paid_days")) {
        await env.DB.prepare("ALTER TABLE pay2_apps ADD COLUMN paid_days INTEGER NOT NULL DEFAULT 30").run();
      }

      await env.DB.batch([
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS pay2_idx_sessions_user ON pay2_sessions(user_id)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS pay2_idx_access_user ON pay2_access(user_id)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS pay2_idx_access_app ON pay2_access(app_id)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS pay2_idx_payments_user ON pay2_payments(user_id)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS pay2_idx_admin_sessions_expiry ON pay2_admin_sessions(expires_at)`)
      ]);

      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pay2_apps").first();
      if (!row || Number(row.n) === 0) {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO pay2_apps
             (id,name,url,billing_mode,trial_days,monthly_price,paid_days,enabled)
             VALUES(?,?,?,?,?,?,?,1)`
          ).bind("farm", "農作業日誌", "https://example.com/farm", "subscription", 30, 500, 30),

          env.DB.prepare(
            `INSERT INTO pay2_apps
             (id,name,url,billing_mode,trial_days,monthly_price,paid_days,enabled)
             VALUES(?,?,?,?,?,?,?,1)`
          ).bind("free-sample", "無料サンプルアプリ", "https://example.com/free", "free", 0, 0, 30)
        ]);
      }
    });
  }

  return schemaPromise;
}

async function getSetting(env, key, fallback = "") {
  const row = await env.DB.prepare("SELECT value FROM pay2_settings WHERE key=?").bind(key).first();
  return row ? String(row.value) : fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO pay2_settings(key,value,updated_at)
     VALUES(?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ).bind(key, String(value ?? "")).run();
}

async function getPublicConfig(env) {
  const mode = await getSetting(env, "square_mode", "sandbox");
  const appId = await getSetting(env, "square_app_id", "");
  const locationId = await getSetting(env, "square_location_id", "");
  return json({
    mode,
    square_app_id: appId,
    square_location_id: locationId,
    square_public_ready: !!(appId && locationId),
    square_secret_ready: !!env.SQUARE_ACCESS_TOKEN,
    d1_ready: !!env.DB,
    r2_ready: !!env.BUCKET
  });
}

async function getSquareSettings(env) {
  const mode = await getSetting(env, "square_mode", "sandbox");
  const appId = await getSetting(env, "square_app_id", "");
  const locationId = await getSetting(env, "square_location_id", "");
  return json({
    mode,
    square_app_id: appId,
    square_location_id: locationId,
    square_secret_ready: !!env.SQUARE_ACCESS_TOKEN
  });
}

async function saveSquareSettings(request, env) {
  const b = await readJson(request);
  const mode = b.mode === "production" ? "production" : "sandbox";
  const appId = String(b.square_app_id || "").trim();
  const locationId = String(b.square_location_id || "").trim();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pay2_settings(key,value,updated_at) VALUES('square_mode',?,CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`
    ).bind(mode),
    env.DB.prepare(
      `INSERT INTO pay2_settings(key,value,updated_at) VALUES('square_app_id',?,CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`
    ).bind(appId),
    env.DB.prepare(
      `INSERT INTO pay2_settings(key,value,updated_at) VALUES('square_location_id',?,CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`
    ).bind(locationId)
  ]);

  return json({ ok: true });
}

async function listApps(env, includeDisabled = false) {
  const sql = includeDisabled
    ? "SELECT * FROM pay2_apps ORDER BY created_at ASC"
    : "SELECT * FROM pay2_apps WHERE enabled=1 ORDER BY created_at ASC";
  const r = await env.DB.prepare(sql).all();
  return json({ apps: (r.results || []).map(normalizeApp) });
}

function normalizeApp(a) {
  return {
    ...a,
    trial_days: Number(a.trial_days || 0),
    monthly_price: Number(a.monthly_price || 0),
    paid_days: Number(a.paid_days || 30),
    enabled: !!a.enabled
  };
}

async function saveApp(request, env) {
  const b = await readJson(request);
  const id = safeId(b.id || crypto.randomUUID().slice(0, 8));
  const name = String(b.name || "").trim();
  const url = String(b.url || "").trim();
  const billingMode = ["free", "subscription"].includes(b.billing_mode)
    ? b.billing_mode
    : Number(b.monthly_price || 0) > 0
      ? "subscription"
      : "free";
  const trialDays = clampInt(b.trial_days, 0, 3650);
  const monthlyPrice = clampInt(b.monthly_price, 0, 10000000);
  const paidDays = clampInt(b.paid_days || 30, 1, 3650);
  const enabled = b.enabled === false ? 0 : 1;

  if (!name) throw httpError(400, "アプリ名が必要です");
  if (url && !/^https:\/\//i.test(url)) {
    throw httpError(400, "URLは https:// から入力してください");
  }

  await env.DB.prepare(
    `INSERT INTO pay2_apps
      (id,name,url,billing_mode,trial_days,monthly_price,paid_days,enabled,updated_at)
     VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       url=excluded.url,
       billing_mode=excluded.billing_mode,
       trial_days=excluded.trial_days,
       monthly_price=excluded.monthly_price,
       paid_days=excluded.paid_days,
       enabled=excluded.enabled,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(id, name, url, billingMode, trialDays, monthlyPrice, paidDays, enabled).run();

  return json({ ok: true, id });
}

async function disableApp(id, env) {
  await env.DB.prepare(
    "UPDATE pay2_apps SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(id).run();
  return json({ ok: true });
}

async function createSession(request, env) {
  const b = await readJson(request);
  const email = String(b.email || "").trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw httpError(400, "メールアドレスを確認してください");
  }

  let user = await env.DB.prepare("SELECT * FROM pay2_users WHERE email=?").bind(email).first();

  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pay2_users(id,email) VALUES(?,?)"
    ).bind(id, email).run();
    user = { id, email };
  }

  const token = randomToken();
  const hash = await sha256(token);
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();

  await env.DB.prepare(
    "INSERT INTO pay2_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)"
  ).bind(hash, user.id, expires).run();

  const res = json({ ok: true, user: { id: user.id, email: user.email } });
  res.headers.append(
    "Set-Cookie",
    `pay2_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`
  );
  return res;
}

async function getMe(request, env) {
  const u = await sessionUser(request, env, false);
  return json({ user: u ? { id: u.id, email: u.email } : null });
}

async function logout(request, env) {
  const token = getCookie(request, "pay2_session");
  if (token) {
    const hash = await sha256(token);
    await env.DB.prepare("DELETE FROM pay2_sessions WHERE token_hash=?").bind(hash).run();
  }

  const res = json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    "pay2_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  return res;
}

async function getApp(env, id) {
  const app = await env.DB.prepare(
    "SELECT * FROM pay2_apps WHERE id=? AND enabled=1"
  ).bind(id).first();
  if (!app) throw httpError(404, "アプリが見つかりません");
  return normalizeApp(app);
}

function evaluateAccess(app, row) {
  if (app.billing_mode === "free" || app.monthly_price <= 0) {
    return { allowed: true, reason: "free", status: "free" };
  }

  if (!row) {
    return { allowed: false, reason: "not_started", status: "none" };
  }

  if (row.status === "active") {
    if (!row.active_until || new Date(row.active_until).getTime() >= Date.now()) {
      return {
        allowed: true,
        reason: "active",
        status: "active",
        active_until: row.active_until || null
      };
    }
    return { allowed: false, reason: "expired", status: "expired" };
  }

  if (row.status === "trialing") {
    const end = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    if (end >= Date.now()) {
      return {
        allowed: true,
        reason: "trial",
        status: "trialing",
        trial_ends_at: row.trial_ends_at
      };
    }
    return {
      allowed: false,
      reason: "trial_ended",
      status: "expired",
      trial_ends_at: row.trial_ends_at
    };
  }

  return {
    allowed: false,
    reason: row.status || "payment_required",
    status: row.status || "none"
  };
}

async function startAccess(request, env) {
  const user = await sessionUser(request, env, true);
  const b = await readJson(request);
  const app = await getApp(env, String(b.app_id || ""));

  let access = await env.DB.prepare(
    "SELECT * FROM pay2_access WHERE user_id=? AND app_id=?"
  ).bind(user.id, app.id).first();

  if (app.billing_mode === "free" || app.monthly_price <= 0) {
    return json({
      ok: true,
      app,
      access: { allowed: true, reason: "free", status: "free" }
    });
  }

  if (!access && app.trial_days > 0) {
    const start = new Date();
    const end = new Date(start.getTime() + app.trial_days * 86400000);
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO pay2_access
       (id,user_id,app_id,status,trial_started_at,trial_ends_at)
       VALUES(?,?,?,?,?,?)`
    ).bind(id, user.id, app.id, "trialing", start.toISOString(), end.toISOString()).run();

    access = await env.DB.prepare(
      "SELECT * FROM pay2_access WHERE user_id=? AND app_id=?"
    ).bind(user.id, app.id).first();
  }

  return json({ ok: true, app, access: evaluateAccess(app, access) });
}

async function checkAccess(request, env, url) {
  const user = await sessionUser(request, env, true);
  const app = await getApp(env, String(url.searchParams.get("app_id") || ""));
  const row = await env.DB.prepare(
    "SELECT * FROM pay2_access WHERE user_id=? AND app_id=?"
  ).bind(user.id, app.id).first();

  return json({
    ok: true,
    app,
    access: evaluateAccess(app, row)
  });
}

async function sandboxPayment(request, env) {
  const mode = await getSetting(env, "square_mode", "sandbox");
  if (mode !== "sandbox") {
    throw httpError(403, "このテスト決済はSandbox専用です");
  }
  if (!env.SQUARE_ACCESS_TOKEN) {
    throw httpError(500, "SQUARE_ACCESS_TOKEN Secret が未設定です");
  }

  const user = await sessionUser(request, env, true);
  const b = await readJson(request);
  const app = await getApp(env, String(b.app_id || ""));
  const sourceId = String(b.source_id || "");

  if (!sourceId) throw httpError(400, "Squareのカードトークンがありません");
  if (app.monthly_price <= 0) throw httpError(400, "このアプリは無料です");

  const locationId = await getSetting(env, "square_location_id", "");
  if (!locationId) throw httpError(500, "Square Location ID が未設定です");

  const body = {
    source_id: sourceId,
    idempotency_key: crypto.randomUUID(),
    amount_money: { amount: app.monthly_price, currency: "JPY" },
    location_id: locationId,
    autocomplete: true,
    buyer_email_address: user.email,
    note: `共通利用センター Sandbox / ${app.name}`
  };

  const result = await squareFetch(env, "/v2/payments", {
    method: "POST",
    body: JSON.stringify(body)
  });

  const payment = result.payment || {};

  await env.DB.prepare(
    `INSERT INTO pay2_payments
     (id,user_id,app_id,square_payment_id,amount,currency,status,mode)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(
    crypto.randomUUID(),
    user.id,
    app.id,
    payment.id || "",
    app.monthly_price,
    "JPY",
    payment.status || "UNKNOWN",
    "sandbox"
  ).run();

  if (payment.status === "COMPLETED" || payment.status === "APPROVED") {
    const paidDays = Math.max(1, Number(app.paid_days || 30));
    const activeUntil = new Date(Date.now() + paidDays * 86400000).toISOString();

    await env.DB.prepare(
      `INSERT INTO pay2_access
       (id,user_id,app_id,status,active_until,updated_at)
       VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(user_id,app_id) DO UPDATE SET
         status='active',
         active_until=excluded.active_until,
         updated_at=CURRENT_TIMESTAMP`
    ).bind(crypto.randomUUID(), user.id, app.id, "active", activeUntil).run();
  }

  return json({
    ok: true,
    payment: {
      id: payment.id,
      status: payment.status,
      amount: app.monthly_price,
      paid_days: Number(app.paid_days || 30)
    }
  });
}

async function squareConnectionTest(env) {
  if (!env.SQUARE_ACCESS_TOKEN) {
    throw httpError(500, "SQUARE_ACCESS_TOKEN Secret が未設定です");
  }

  const locationId = await getSetting(env, "square_location_id", "");
  if (!locationId) throw httpError(500, "Square Location ID が未設定です");

  const r = await squareFetch(env, "/v2/locations", { method: "GET" });
  const locations = r.locations || [];
  const matched = locations.some((x) => x.id === locationId);

  return json({
    ok: true,
    matched_location: matched,
    locations: locations.map((x) => ({
      id: x.id,
      name: x.name,
      status: x.status,
      country: x.country,
      currency: x.currency
    }))
  });
}

async function squareFetch(env, path, options = {}) {
  const mode = await getSetting(env, "square_mode", "sandbox");
  const base =
    mode === "production"
      ? "https://connect.squareup.com"
      : "https://connect.squareupsandbox.com";

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${env.SQUARE_ACCESS_TOKEN}`);
  headers.set("Square-Version", SQUARE_API_VERSION);
  headers.set("Content-Type", "application/json");

  const response = await fetch(base + path, { ...options, headers });
  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail =
      data.errors?.map((e) => e.detail || e.code).join(" / ") ||
      text ||
      `Square HTTP ${response.status}`;
    throw httpError(502, "Square API エラー", detail);
  }

  return data;
}

async function listUsers(env) {
  const users = await env.DB.prepare(
    `SELECT id,email,display_name,created_at,updated_at
     FROM pay2_users ORDER BY created_at DESC LIMIT 200`
  ).all();

  const access = await env.DB.prepare(
    `SELECT a.user_id,a.app_id,a.status,a.trial_ends_at,a.active_until,
            p.name AS app_name
     FROM pay2_access a
     LEFT JOIN pay2_apps p ON p.id=a.app_id
     ORDER BY a.updated_at DESC LIMIT 500`
  ).all();

  return json({
    users: users.results || [],
    access: access.results || []
  });
}

async function adminSetAccess(request, env) {
  const b = await readJson(request);
  const userId = String(b.user_id || "");
  const appId = String(b.app_id || "");
  const status = ["active", "suspended", "expired", "canceled"].includes(b.status)
    ? b.status
    : "active";
  const activeUntil = b.active_until ? String(b.active_until) : null;

  if (!userId || !appId) throw httpError(400, "user_id と app_id が必要です");

  await env.DB.prepare(
    `INSERT INTO pay2_access
     (id,user_id,app_id,status,active_until,updated_at)
     VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(user_id,app_id) DO UPDATE SET
       status=excluded.status,
       active_until=excluded.active_until,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(crypto.randomUUID(), userId, appId, status, activeUntil).run();

  return json({ ok: true });
}

async function sessionUser(request, env, required = true) {
  const token = getCookie(request, "pay2_session");

  if (!token) {
    if (required) throw httpError(401, "利用者ログインが必要です");
    return null;
  }

  const hash = await sha256(token);

  const user = await env.DB.prepare(
    `SELECT u.id,u.email,u.display_name
     FROM pay2_sessions s
     JOIN pay2_users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP`
  ).bind(hash).first();

  if (!user && required) throw httpError(401, "ログイン期限が切れています");
  return user || null;
}

async function adminLogin(request, env) {
  const b = await readJson(request);
  const password = String(b.password || "");
  if (!password) throw httpError(400, "管理者パスワードを入力してください");
  if (!(await verifyAdminPassword(env, password))) {
    throw httpError(401, "管理者パスワードが違います");
  }
  return createAdminSessionResponse(env, { ok: true });
}

async function adminLogout(request, env) {
  const token = getCookie(request, "pay2_admin_session");
  if (token) {
    const hash = await sha256(token);
    await env.DB.prepare("DELETE FROM pay2_admin_sessions WHERE token_hash=?").bind(hash).run();
  }
  const res = json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    "pay2_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
  );
  return res;
}

async function changeAdminPassword(request, env) {
  const b = await readJson(request);
  const currentPassword = String(b.current_password || "");
  const newPassword = String(b.new_password || "");

  if (!(await verifyAdminPassword(env, currentPassword))) {
    throw httpError(401, "現在の管理者パスワードが違います");
  }
  if (newPassword.length < 10) {
    throw httpError(400, "新しい管理者パスワードは10文字以上にしてください");
  }
  if (newPassword.length > 128) {
    throw httpError(400, "新しい管理者パスワードが長すぎます");
  }
  if (newPassword === currentPassword) {
    throw httpError(400, "現在とは異なるパスワードを設定してください");
  }

  await setAdminPassword(env, newPassword);
  await env.DB.prepare("DELETE FROM pay2_admin_sessions").run();
  return createAdminSessionResponse(env, { ok: true, changed: true });
}

async function verifyAdminPassword(env, password) {
  if (!env.ADMIN_KEY) {
    throw httpError(500, "ADMIN_KEY Secret が未設定です");
  }

  const row = await env.DB.prepare(
    "SELECT password_salt,password_hash,iterations FROM pay2_admin_auth WHERE id='primary'"
  ).first();

  if (!row) {
    const [a, b] = await Promise.all([sha256(String(password)), sha256(String(env.ADMIN_KEY))]);
    return constantTimeHexEqual(a, b);
  }

  const iterations = Math.max(100000, Number(row.iterations || 210000));
  const derived = await adminPasswordHash(String(password), String(row.password_salt), iterations, env);
  return constantTimeHexEqual(derived, String(row.password_hash));
}

async function setAdminPassword(env, password) {
  if (!env.ADMIN_KEY) throw httpError(500, "ADMIN_KEY Secret が未設定です");
  const salt = randomHex(16);
  const iterations = 210000;
  const hash = await adminPasswordHash(String(password), salt, iterations, env);

  await env.DB.prepare(
    `INSERT INTO pay2_admin_auth(id,password_salt,password_hash,iterations,updated_at)
     VALUES('primary',?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       password_salt=excluded.password_salt,
       password_hash=excluded.password_hash,
       iterations=excluded.iterations,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(salt, hash, iterations).run();
}

async function adminPasswordHash(password, saltHex, iterations, env) {
  const material = new TextEncoder().encode(`${password}\n${String(env.ADMIN_KEY)}`);
  const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function createAdminSessionResponse(env, payload) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const maxAge = 12 * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO pay2_admin_sessions(token_hash,expires_at) VALUES(?,?)"
  ).bind(tokenHash, expiresAt).run();

  const res = json(payload);
  res.headers.append(
    "Set-Cookie",
    `pay2_admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
  return res;
}

async function requireAdmin(request, env) {
  const token = getCookie(request, "pay2_admin_session");
  if (!token) throw httpError(401, "管理者ログインが必要です");

  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT token_hash FROM pay2_admin_sessions WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP"
  ).bind(tokenHash).first();

  if (!row) throw httpError(401, "管理者ログインの有効期限が切れています");
}

function randomHex(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function constantTimeHexEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, "JSONを読み込めません");
  }
}

function safeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || crypto.randomUUID().slice(0, 8);
}

function clampInt(value, min, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail;
  return e;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
