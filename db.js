// PostgreSQL is the production source of truth. In production the application
// state is stored in PostgreSQL app_state and every persistence operation is
// transactional. The JSON file is development-only and is never read in
// production.
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { hashPassword } = require('./utils');

const defaults = {
  lotteries: [], results: [], purchases: [], users: [], watchedNumbers: [],
  notifications: [], settings: {
    siteName: 'Haryana Results',
    disclaimerText: 'This site provides lottery results for informational purposes only. Results are compiled from publicly available sources. We do not sell tickets, accept payments, or facilitate any real-money gambling. Please verify results with the official source before acting on them.',
    privacyText: 'We collect only what is needed to run your account: a login session, and the ticket/number details you choose to save. Passwords are stored securely (hashed) and never in plain text. We do not sell your data to third parties. Use of this site is at your own discretion.',
    aboutText: 'This site publishes daily lottery results for informational purposes. For questions, corrections, or support, please use the contact details shown at the bottom of the site.',
  }, auditLog: [],
  analytics: {}, visitorSessions: {}
};

const postgresEnabled = !!process.env.DATABASE_URL;
const productionWithoutDb = process.env.NODE_ENV === 'production' && !postgresEnabled;
let state = JSON.parse(JSON.stringify(defaults));
let pool = null;
let initError = null;
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
let writeTimer = null;
let writeQueued = false;
let writing = Promise.resolve();

function clone(v) {
  // JSON.stringify(undefined) returns undefined, which JSON.parse cannot parse.
  // A .find() with no match must safely return undefined instead of crashing the request.
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}
function deepMerge(base, extra) {
  const out = clone(base);
  Object.keys(extra || {}).forEach(k => {
    if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], extra[k]);
    else out[k] = clone(extra[k]);
  });
  return out;
}

// Development-only JSON compatibility. Never instantiate/read it in production.
let jsonDb = null;
if (!postgresEnabled && !productionWithoutDb) {
  const low = require('lowdb');
  const FileSync = require('lowdb/adapters/FileSync');
  const adapter = new FileSync(path.join(__dirname, 'data-db.json'));
  jsonDb = low(adapter);
  jsonDb.defaults(defaults).write();
  state = deepMerge(defaults, jsonDb.value() || {});
}

function getPath(obj, pathString) {
  return String(pathString).split('.').reduce((acc, key) => acc == null ? undefined : acc[key], obj);
}
function setPath(obj, pathString, value) {
  const parts = String(pathString).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = clone(value);
}
function matches(obj, query) { return Object.keys(query || {}).every(k => getPath(obj, k) === query[k]); }

class Chain {
  constructor(value, rootPath = null) { this.valueData = value; this.rootPath = rootPath; }
  value() { return clone(this.valueData); }
  find(queryOrFn) {
    const arr = Array.isArray(this.valueData) ? this.valueData : [];
    const predicate = typeof queryOrFn === 'function' ? queryOrFn : x => matches(x, queryOrFn);
    return new Chain(arr.find(predicate), { parent: this.valueData, type: 'find', query: queryOrFn });
  }
  filter(queryOrFn) {
    const arr = Array.isArray(this.valueData) ? this.valueData : [];
    return new Chain(typeof queryOrFn === 'function' ? arr.filter(queryOrFn) : arr.filter(x => matches(x, queryOrFn)), { parent: this.valueData, type: 'filter' });
  }
  sortBy(keys) {
    const ks = Array.isArray(keys) ? keys : [keys];
    const out = clone(this.valueData || []).sort((a, b) => {
      for (const k of ks) {
        const av = getPath(a, k), bv = getPath(b, k);
        if (av === bv) continue;
        return av < bv ? -1 : 1;
      }
      return 0;
    });
    return new Chain(out);
  }
  reverse() { return new Chain((this.valueData || []).slice().reverse()); }
  slice(...args) { return new Chain((this.valueData || []).slice(...args)); }
  push(item) { if (Array.isArray(this.valueData)) this.valueData.push(clone(item)); return this; }
  assign(obj) { if (this.valueData && typeof this.valueData === 'object') Object.assign(this.valueData, clone(obj)); return this; }
  remove(query) {
    if (!Array.isArray(this.valueData)) return this;
    const kept = this.valueData.filter(x => !matches(x, query));
    this.valueData.length = 0;
    kept.forEach(x => this.valueData.push(x));
    return this;
  }
  write() { persistState(); return this; }
}
function dbGet(p) { return new Chain(getPath(state, p), p); }
function dbSet(p, v) { setPath(state, p, v); return new Chain(getPath(state, p), p); }
function dbDefaults(o) { state = deepMerge(o, state); return new Chain(state); }

async function createNormalizedTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY,name text NOT NULL,user_code text NOT NULL,password_hash text NOT NULL,active boolean NOT NULL DEFAULT true,session_version integer NOT NULL DEFAULT 0,recovery_code_hash text,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash text`);
  // Login is case-insensitive, so the database must enforce the same rule.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_user_code_lower_idx ON users (lower(user_code))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lotteries (id text PRIMARY KEY,name text NOT NULL,slug text NOT NULL UNIQUE,draw_time text,starred boolean NOT NULL DEFAULT false,is_main boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE lotteries ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS purchases (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE SET NULL,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),buyer_name text NOT NULL,tickets integer NOT NULL CHECK(tickets>0 AND tickets<=100000),amount numeric NOT NULL DEFAULT 0 CHECK(amount>=0 AND amount<=10000000),request_id text,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS request_id text`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS purchases_user_request_idx ON purchases(user_id,request_id) WHERE request_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS purchases_user_lottery_idx ON purchases(user_id,lottery_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS purchases_lottery_number_idx ON purchases(lottery_id,number)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS results (id text PRIMARY KEY,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,date date NOT NULL,result_text text NOT NULL,updated_at timestamptz,deleted_at timestamptz)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS results_lottery_date_active_idx ON results(lottery_id,date) WHERE deleted_at IS NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS watched_numbers (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS watched_unique_idx ON watched_numbers(user_id,lottery_id,number)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text,result_date date,number text,title text,message text,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,type text)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (id text PRIMARY KEY,action text,detail text,ip text,timestamp timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_visits (visit_date date PRIMARY KEY,visits integer NOT NULL DEFAULT 0,unique_sessions integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS visitor_daily (visit_date date NOT NULL,visitor_id text NOT NULL,PRIMARY KEY(visit_date,visitor_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1),data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
}

function sanitizeStateForRelationalSync() {
  // PostgreSQL is the production source of truth, so the JSON snapshot must
  // also be a valid relational snapshot. Older app versions could leave
  // orphaned child rows behind after a lottery/user was deleted. That made a
  // completely unrelated later save fail inside the all-or-nothing sync
  // transaction with a foreign-key/unique-constraint error.
  const seenUsers = new Set();
  state.users = (state.users || []).filter(u => {
    const key = String(u.userCode || '').trim().toLowerCase();
    if (!u.id || !key || seenUsers.has(key)) return false;
    seenUsers.add(key); return true;
  });

  const seenSlugs = new Set();
  state.lotteries = (state.lotteries || []).filter(l => {
    const key = String(l.slug || '').trim().toLowerCase();
    if (!l.id || !key || seenSlugs.has(key)) return false;
    seenSlugs.add(key); return true;
  });

  const validUserIds = new Set(state.users.map(u => u.id));
  const validLotteryIds = new Set(state.lotteries.map(l => l.id));

  const seenPurchaseIds = new Set();
  const seenPurchaseRequests = new Set();
  state.purchases = (state.purchases || []).filter(p => {
    if (!p.id || seenPurchaseIds.has(p.id)) return false;
    seenPurchaseIds.add(p.id);
    if (p.userId && !validUserIds.has(p.userId)) p.userId = null;
    if (p.lotteryId && !validLotteryIds.has(p.lotteryId)) p.lotteryId = null;
    if (p.requestId && p.userId) {
      const key = `${p.userId}:${p.requestId}`;
      if (seenPurchaseRequests.has(key)) return false;
      seenPurchaseRequests.add(key);
    }
    return true;
  });

  const seenResultIds = new Set();
  const seenActiveResults = new Set();
  state.results = (state.results || []).filter(r => {
    if (!r.id || seenResultIds.has(r.id) || !validLotteryIds.has(r.lotteryId)) return false;
    seenResultIds.add(r.id);
    if (!r.deletedAt) {
      const key = `${r.lotteryId}:${r.date}`;
      if (seenActiveResults.has(key)) return false;
      seenActiveResults.add(key);
    }
    return true;
  });

  const seenWatchedIds = new Set();
  const seenWatchedKeys = new Set();
  state.watchedNumbers = (state.watchedNumbers || []).filter(w => {
    if (!w.id || seenWatchedIds.has(w.id) || !validLotteryIds.has(w.lotteryId) || !validUserIds.has(w.userId)) return false;
    const key = `${w.userId}:${w.lotteryId}:${w.number}`;
    if (seenWatchedKeys.has(key)) return false;
    seenWatchedIds.add(w.id);
    seenWatchedKeys.add(key);
    return true;
  });

  const seenNotificationIds = new Set();
  state.notifications = (state.notifications || []).filter(n => {
    if (!n.id || seenNotificationIds.has(n.id) || !validUserIds.has(n.userId)) return false;
    // notifications.lottery_id is nullable, but when present it must refer to
    // an existing lottery. This was the missing orphan-row case that could
    // make every subsequent save fail.
    if (n.lotteryId && !validLotteryIds.has(n.lotteryId)) n.lotteryId = null;
    seenNotificationIds.add(n.id);
    return true;
  });

  const seenAuditIds = new Set();
  state.auditLog = (state.auditLog || []).filter(a => {
    if (!a.id || seenAuditIds.has(a.id)) return false;
    seenAuditIds.add(a.id);
    return true;
  });
}

async function syncNormalizedTables(client) {
  if (!postgresEnabled || !pool || !client) return;
  try {
    // Rebuild the normalized projection from app_state as one exact snapshot.
    // Older versions only upserted current rows, which left deleted rows in
    // PostgreSQL. A later add could then fail on UNIQUE(slug) or UNIQUE(lower(user_code))
    // even though the row no longer existed in the canonical app_state. Clear
    // dependent tables first (their foreign keys point at users/lotteries), then
    // rebuild users and lotteries from the canonical state.
    await client.query('DELETE FROM notifications');
    await client.query('DELETE FROM watched_numbers');
    await client.query('DELETE FROM results');
    await client.query('DELETE FROM purchases');
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM lotteries');
    await client.query('DELETE FROM users');

    for (const u of state.users || []) {
      await client.query(`INSERT INTO users(id,name,user_code,password_hash,active,session_version,recovery_code_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()))`, [u.id,u.name,String(u.userCode).trim(),u.passwordHash,u.active!==false,Number(u.sessionVersion||0),u.recoveryCodeHash||null,u.createdAt]);
    }
    for (const l of state.lotteries || []) {
      await client.query(`INSERT INTO lotteries(id,name,slug,draw_time,starred,is_main,created_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now()))`, [l.id,l.name,l.slug,l.drawTime||null,!!l.starred,!!l.isMain,l.createdAt]);
    }
    for (const x of state.purchases || []) {
      const tickets = Number(x.tickets); const amount = Number(x.amount);
      if (!/^\d{2}$/.test(String(x.number)) || !Number.isInteger(tickets) || tickets < 1 || tickets > 100000 || !Number.isFinite(amount) || amount < 0 || amount > 10000000) continue;
      await client.query(`INSERT INTO purchases(id,user_id,lottery_id,number,buyer_name,tickets,amount,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()))`, [x.id,x.userId && validId(state.users,x.userId) ? x.userId : null,x.lotteryId && validId(state.lotteries,x.lotteryId) ? x.lotteryId : null,String(x.number),String(x.buyerName||''),tickets,amount,x.requestId||null,x.createdAt]);
    }
    const activeResultKeys = new Set();
    for (const x of state.results || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))) continue;
      const key = `${x.lotteryId}:${x.date}`;
      if (!x.deletedAt && activeResultKeys.has(key)) continue;
      if (!x.deletedAt) activeResultKeys.add(key);
      await client.query(`INSERT INTO results(id,lottery_id,date,result_text,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6)`, [x.id,x.lotteryId,x.date,String(x.resultText||''),x.updatedAt||null,x.deletedAt||null]);
    }
    const watchedKeys = new Set();
    for (const x of state.watchedNumbers || []) {
      const key = `${x.userId}:${x.lotteryId}:${x.number}`;
      if (watchedKeys.has(key)) continue; watchedKeys.add(key);
      if (!/^\d{2}$/.test(String(x.number))) continue;
      await client.query(`INSERT INTO watched_numbers(id,user_id,lottery_id,number,created_at) VALUES($1,$2,$3,$4,COALESCE($5,now()))`, [x.id,x.userId,x.lotteryId,String(x.number),x.createdAt]);
    }
    for (const x of state.notifications || []) {
      await client.query(`INSERT INTO notifications(id,user_id,lottery_id,result_date,number,title,message,created_at,read_at,type) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()),$9,$10)`, [x.id,x.userId,x.lotteryId||null,x.resultDate||null,x.number||null,x.title||'',x.message||'',x.createdAt,x.readAt||null,x.type||null]);
    }
    for (const x of state.auditLog || []) {
      await client.query(`INSERT INTO audit_log(id,action,detail,ip,timestamp) VALUES($1,$2,$3,$4,COALESCE($5,now()))`, [x.id,x.action||'',x.detail||'',x.ip||'',x.timestamp]);
    }
  } catch (e) { throw e; }
}
function validId(list, id) { return list.some(x => x.id === id); }

async function initPostgres() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10 });
  await pool.query('SELECT 1');
  await createNormalizedTables();
  const r = await pool.query('SELECT data FROM app_state WHERE id=1');
  if (r.rows.length) state = deepMerge(defaults, r.rows[0].data || {});
  else await pool.query('INSERT INTO app_state(id,data) VALUES(1,$1::jsonb)', [JSON.stringify(defaults)]);
  // Seed 2FA from the environment only on first initialization.
// An explicitly empty stored value means the administrator intentionally disabled 2FA,
// so never re-enable it from ADMIN_TOTP_SECRET on a later restart.
if (
  process.env.ADMIN_TOTP_SECRET &&
  !Object.prototype.hasOwnProperty.call(state.settings || {}, 'adminTotpSecret')
) {
  state.settings.adminTotpSecret = process.env.ADMIN_TOTP_SECRET;
}
  await ensureDefaults();
}

async function persistState(force = false) {
  if (!postgresEnabled || !pool) {
    if (productionWithoutDb) throw new Error('DATABASE_URL is required in production.');
    if (jsonDb) { jsonDb.setState(state); jsonDb.write(); }
    return;
  }
  writeQueued = true;
  if (writeTimer) clearTimeout(writeTimer);
  if (force) return flushState();
  writeTimer = setTimeout(() => flushState().catch(e => console.error('Database persistence failed:', e.message)), 0);
}
async function flushState() {
  if (!postgresEnabled || !pool || !writeQueued) return;
  writeQueued = false;
  sanitizeStateForRelationalSync();
  const snapshot = clone(state);
  writing = writing.then(async () => {
    // app_state is the canonical application store. Commit it independently
    // from the optional relational projection so a stale/legacy row in one of
    // the projection tables can NEVER make a normal application save fail.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(734291)');
      await client.query('UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE id=1', [JSON.stringify(snapshot)]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    // Keep normalized tables synchronized for backups/integrations, but do not
    // turn projection-only problems into application save failures. The next
    // successful write will retry the projection.
    const projectionClient = await pool.connect();
    try {
      await projectionClient.query('BEGIN');
      await projectionClient.query('SELECT pg_advisory_xact_lock(734291)');
      await syncNormalizedTables(projectionClient);
      await projectionClient.query('COMMIT');
    } catch (projectionError) {
      try { await projectionClient.query('ROLLBACK'); } catch (_) {}
      console.error('PostgreSQL normalized projection sync failed; app_state was saved successfully:', projectionError.message);
    } finally {
      projectionClient.release();
    }
  });
  await writing;
}

async function ensureDefaults() {
  state = deepMerge(defaults, state);
  (state.users || []).forEach(u => { if (u.sessionVersion == null) u.sessionVersion = 0; });
  if (!state.settings.adminPasswordHash) {
    const initialAdminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
    if (!initialAdminPassword) {
      throw new Error('ADMIN_PASSWORD is required to create the initial admin account; no default password is allowed.');
    }
    state.settings.adminPasswordHash = hashPassword(initialAdminPassword);
  }
  state.settings.contactNumber = state.settings.contactNumber ?? '';
  state.settings.contactLabel = state.settings.contactLabel ?? 'Help & Queries';
  state.settings.contactType = state.settings.contactType ?? 'call';
  state.settings.adminSessionVersion = Number(state.settings.adminSessionVersion || 0);
  state.settings.adminTotpSecret = state.settings.adminTotpSecret || '';
  state.settings.backupVersion = Number(state.settings.backupVersion || 1);
  await persistState(true);
}
function cleanupOldResults() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 40); const c = cutoff.toISOString().slice(0,10); let n = 0;
  (state.results || []).forEach(r => { if (!r.deletedAt && r.date < c) { r.deletedAt = new Date().toISOString(); r.autoDeleted = true; n++; } });
  if (n) persistState().catch(e => console.error('Result cleanup persistence failed:', e.message));
  return n;
}
async function recordVisit(visitorId, dateStr) {
  if (!postgresEnabled || !pool) {
    const key = `analytics.${dateStr}`; const cur = Number(dbGet(key).value() || 0) + 1; dbSet(key, cur).write(); return { visits: cur, uniqueSessions: cur };
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO daily_visits(visit_date,visits,unique_sessions) VALUES($1,1,0) ON CONFLICT(visit_date) DO UPDATE SET visits=daily_visits.visits+1,updated_at=now()`, [dateStr]);
    const ins = await c.query(`INSERT INTO visitor_daily(visit_date,visitor_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [dateStr, visitorId]);
    if (ins.rowCount) await c.query(`UPDATE daily_visits SET unique_sessions=unique_sessions+1,updated_at=now() WHERE visit_date=$1`, [dateStr]);
    const r = await c.query(`SELECT visits,unique_sessions AS "uniqueSessions" FROM daily_visits WHERE visit_date=$1`, [dateStr]);
    await c.query('COMMIT'); return r.rows[0];
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function getVisitStats(days = 14) {
  if (!postgresEnabled || !pool) return null;
  const r = await pool.query(`SELECT visit_date::text AS date,visits,unique_sessions AS "uniqueSessions" FROM daily_visits WHERE visit_date>=CURRENT_DATE-$1::int ORDER BY visit_date DESC`, [days - 1]);
  return r.rows;
}
// Shared by both an immediate result post and the scheduled-publish checker,
// so a follower only ever gets notified once, at the moment their number
// actually becomes public — not the moment an admin merely saves it.
function notifyResultWatchers(lottery, result) {
  const publishedNumbers = (result.resultText.match(/\d{1,2}/g) || []).map((n) => n.padStart(2, '0'));
  const matchingWatches = (dbGet('watchedNumbers').value() || []).filter(
    (w) => w.lotteryId === lottery.id && publishedNumbers.includes(w.number)
  );
  matchingWatches.forEach((w) => {
    const user = dbGet('users').find({ id: w.userId }).value();
    if (!user || user.notificationsEnabled === false) return;
    const already = dbGet('notifications').find({
      userId: w.userId,
      lotteryId: lottery.id,
      resultDate: result.date,
      number: w.number,
    }).value();
    if (already) return;
    dbGet('notifications').push({
      id: crypto.randomUUID(),
      userId: w.userId,
      lotteryId: lottery.id,
      resultDate: result.date,
      number: w.number,
      title: 'Result notification',
      message: `${lottery.name}: published result for ${result.date} contains your followed number ${w.number}.`,
      createdAt: new Date().toISOString(),
      readAt: null,
      type: 'result',
    }).write();
    try {
      const webpush = require('web-push');
      const publicKey = process.env.VAPID_PUBLIC_KEY;
      const privateKey = process.env.VAPID_PRIVATE_KEY;
      const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
      if (publicKey && privateKey && user.pushSubscription) {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        webpush
          .sendNotification(
            user.pushSubscription,
            JSON.stringify({
              title: 'Result notification',
              body: `${lottery.name}: your followed number ${w.number} appeared in the result for ${result.date}.`,
              url: '/account',
            })
          )
          .catch(() => {});
      }
    } catch (e) {
      /* optional dependency/configuration */
    }
  });
}

// Checked on a short interval from server.js. Any result an admin scheduled
// ahead of time (entered during the 15-minute closing window, but held back
// until the official draw time) flips to published here, automatically,
// even if nobody is looking at the admin panel at that exact moment.
async function publishDueScheduledResults() {
  const nowIso = new Date().toISOString();
  const due = (dbGet('results').value() || []).filter(
    (r) => r.published === false && r.scheduledFor && r.scheduledFor <= nowIso && !r.deletedAt
  );
  for (const result of due) {
    dbGet('results').find({ id: result.id }).assign({ published: true, updatedAt: new Date().toISOString() }).write();
    const lottery = dbGet('lotteries').find({ id: result.lotteryId }).value();
    if (lottery) notifyResultWatchers(lottery, result);
  }
  if (due.length) await flushState();
}

async function healthCheck() {
  if (!postgresEnabled || !pool) return { ok: false, database: 'not-configured' };
  try { await pool.query('SELECT 1'); return { ok: true, database: 'postgresql' }; }
  catch (e) { console.error('Database health check failed:', e.message); return { ok: false, database: 'postgresql' }; }
}
async function encryptedBackup() {
  if (!postgresEnabled || !pool) throw new Error('PostgreSQL is required for backups.');
  const keyText = process.env.BACKUP_ENCRYPTION_KEY; if (!keyText) throw new Error('BACKUP_ENCRYPTION_KEY is not configured.');
  const safe = clone(state); (safe.users || []).forEach(u => { delete u.passwordHash; delete u.recoveryCodeHash; });
  if (safe.settings) { delete safe.settings.adminPasswordHash; delete safe.settings.adminTotpSecret; }
  const key = crypto.createHash('sha256').update(keyText).digest(); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(safe))), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

const db = { getInitError: () => initError, get: dbGet, set: dbSet, defaults: dbDefaults, value: () => clone(state), getState: () => clone(state), cleanupOldResults, recordVisit, getVisitStats, healthCheck, encryptedBackup, getPool: () => pool, ready, isPostgres: () => postgresEnabled, flush: () => flushState(), persistNow: () => persistState(true), notifyResultWatchers, publishDueScheduledResults };
(async () => {
  try {
    if (productionWithoutDb) throw new Error('DATABASE_URL is required in production. JSON fallback is disabled.');
    if (process.env.NODE_ENV === 'production' && !process.env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY is required in production.');
    if (postgresEnabled) await initPostgres(); else await ensureDefaults();
    readyResolve();
  } catch (err) {
    console.error('Database initialization failed:', err); initError = err; process.exitCode = 1; readyResolve();
  }
})();
module.exports = db;
