// PostgreSQL is the production source of truth. Every read and write goes
// directly to the normalized tables. A lightweight in-memory cache keeps
// db.get(...).value() synchronous so existing routes don't need changes.
// A mutex serializes writes so two simultaneous requests can never corrupt
// the cache or overwrite each other's changes.
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { hashPassword } = require('./utils');

const defaults = {
  lotteries: [], results: [], purchases: [], purchaseHistory: [], users: [], watchedNumbers: [],
  specialLotteries: [], specialResults: [], specialPurchases: [], specialPurchaseHistory: [],
  notifications: [], settings: {
    siteName: 'Haryana Results',
    disclaimerText: 'This site provides lottery results for informational purposes only. Results are compiled from publicly available sources. We do not sell tickets, accept payments, or facilitate any real-money gambling. Please verify results with the official source before acting on them.',
    privacyText: 'We collect only what is needed to run your account: a login session, and the ticket/number details you choose to save. Passwords are stored securely (hashed) and never in plain text. We do not sell your data to third parties. Use of this site is at your own discretion.',
    aboutText: 'This site publishes daily lottery results for informational purposes. For questions, corrections, or support, please use the contact details shown at the bottom of the site.',
    faqText: 'When do results get posted?\nResults are posted as soon as possible after each draw closes, and sometimes automatically at the exact draw time if scheduled ahead of time by an admin.\n\nAre these official results?\nResults shown here are compiled for informational purposes. Please verify with the official source before acting on them.\n\nDo you sell tickets or accept payments?\nNo. This site only displays results — it does not sell tickets or handle real-money gambling.\n\nHow often is this page updated?\nThe page automatically refreshes with the latest result when you return to it after being away.',
    starMode: 'manual',
    specialStarMode: 'manual',
  }, auditLog: [],
  analytics: {}, visitorSessions: {}
};

const postgresEnabled = !!process.env.DATABASE_URL;
const productionWithoutDb = process.env.NODE_ENV === 'production' && !postgresEnabled;
let pool = null;
let initError = null;
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });

// In-memory cache — rebuilt from PostgreSQL on startup and refreshed atomically
// after every write.  Reads are synchronous; writes are async and mutex-locked.
let cache = JSON.parse(JSON.stringify(defaults));

// Serialize all writes so the cache and database stay in perfect sync.
let writeMutex = Promise.resolve();
async function withWriteLock(fn) {
  writeMutex = writeMutex.then(fn, fn);
  return writeMutex;
}

function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
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

function matches(obj, query) {
  return Object.keys(query || {}).every(k => getPath(obj, k) === query[k]);
}

// ---------------------------------------------------------------------------
// TABLE MAPPING
// ---------------------------------------------------------------------------
const TABLE_MAP = {
  lotteries: 'lotteries',
  results: 'results',
  purchases: 'purchases',
  purchaseHistory: 'purchases',
  users: 'users',
  watchedNumbers: 'watched_numbers',
  notifications: 'notifications',
  auditLog: 'audit_log',
  specialLotteries: 'special_lotteries',
  specialResults: 'special_results',
  specialPurchases: 'special_purchases',
  specialPurchaseHistory: 'special_purchases',
};

const SETTINGS_KEYS = Object.keys(defaults.settings);

// ---------------------------------------------------------------------------
// SCHEMA SETUP
// ---------------------------------------------------------------------------
async function createNormalizedTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY,name text NOT NULL,user_code text NOT NULL,password_hash text NOT NULL,active boolean NOT NULL DEFAULT true,session_version integer NOT NULL DEFAULT 0,recovery_code_hash text,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash text`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_user_code_lower_idx ON users (lower(user_code))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lotteries (id text PRIMARY KEY,name text NOT NULL,slug text NOT NULL UNIQUE,draw_time text,starred boolean NOT NULL DEFAULT false,is_main boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE lotteries ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS purchases (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE SET NULL,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),buyer_name text NOT NULL,tickets integer NOT NULL CHECK(tickets>0 AND tickets<=100000),amount numeric NOT NULL DEFAULT 0 CHECK(amount>=0 AND amount<=10000000),request_id text,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS request_id text`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS round_ended_at timestamptz`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS purchases_user_request_idx ON purchases(user_id,request_id) WHERE request_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS purchases_user_lottery_idx ON purchases(user_id,lottery_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS purchases_lottery_number_idx ON purchases(lottery_id,number)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS results (id text PRIMARY KEY,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,date date NOT NULL,result_text text NOT NULL,updated_at timestamptz,deleted_at timestamptz,published boolean DEFAULT true,scheduled_for timestamptz)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS results_lottery_date_active_idx ON results(lottery_id,date) WHERE deleted_at IS NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS watched_numbers (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS watched_unique_idx ON watched_numbers(user_id,lottery_id,number)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text,result_date date,number text,title text,message text,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,type text)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (id text PRIMARY KEY,action text,detail text,ip text,timestamp timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_visits (visit_date date PRIMARY KEY,visits integer NOT NULL DEFAULT 0,unique_sessions integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS visitor_daily (visit_date date NOT NULL,visitor_id text NOT NULL,PRIMARY KEY(visit_date,visitor_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1),data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);

  // Special lottery tables
  await pool.query(`CREATE TABLE IF NOT EXISTS special_lotteries (id text PRIMARY KEY,name text NOT NULL,slug text NOT NULL UNIQUE,draw_time text,starred boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS special_results (id text PRIMARY KEY,lottery_id text REFERENCES special_lotteries(id) ON DELETE CASCADE,date date NOT NULL,result_text text NOT NULL,updated_at timestamptz,deleted_at timestamptz,published boolean DEFAULT true,scheduled_for timestamptz)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS special_results_lottery_date_idx ON special_results(lottery_id,date) WHERE deleted_at IS NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS special_purchases (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE SET NULL,lottery_id text REFERENCES special_lotteries(id) ON DELETE CASCADE,number text NOT NULL,buyer_name text NOT NULL,tickets integer NOT NULL DEFAULT 1,amount numeric NOT NULL DEFAULT 0,request_id text,created_at timestamptz NOT NULL DEFAULT now(),round_ended_at timestamptz)`);

  // Settings table
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
}

// ---------------------------------------------------------------------------
// CACHE MANAGEMENT
// ---------------------------------------------------------------------------
async function refreshCache() {
  if (!postgresEnabled || !pool) return;
  const client = await pool.connect();
  try {
    const [
      lotteries, results, purchases, users, watchedNumbers,
      notifications, auditLog, specialLotteries, specialResults,
      specialPurchases, settingsRows
    ] = await Promise.all([
      client.query('SELECT id, name, slug, draw_time, starred, is_main, created_at FROM lotteries ORDER BY created_at'),
      client.query('SELECT id, lottery_id, date, result_text, updated_at, deleted_at, published, scheduled_for FROM results WHERE deleted_at IS NULL ORDER BY date DESC'),
      client.query('SELECT id, user_id, lottery_id, number, buyer_name, tickets, amount, request_id, created_at, round_ended_at FROM purchases ORDER BY created_at DESC'),
      client.query('SELECT id, name, user_code, password_hash, active, session_version, recovery_code_hash, created_at FROM users ORDER BY created_at'),
      client.query('SELECT id, user_id, lottery_id, number, created_at FROM watched_numbers ORDER BY created_at'),
      client.query('SELECT id, user_id, lottery_id, result_date, number, title, message, created_at, read_at, type FROM notifications ORDER BY created_at DESC'),
      client.query('SELECT id, action, detail, ip, timestamp FROM audit_log ORDER BY timestamp DESC LIMIT 500'),
      client.query('SELECT id, name, slug, draw_time, starred, created_at FROM special_lotteries ORDER BY created_at'),
      client.query('SELECT id, lottery_id, date, result_text, updated_at, deleted_at, published, scheduled_for FROM special_results WHERE deleted_at IS NULL ORDER BY date DESC'),
      client.query('SELECT id, user_id, lottery_id, number, buyer_name, tickets, amount, request_id, created_at, round_ended_at FROM special_purchases ORDER BY created_at DESC'),
      client.query('SELECT key, value FROM settings'),
    ]);

    const newCache = JSON.parse(JSON.stringify(defaults));
    newCache.lotteries = lotteries.rows.map(r => ({...r, isMain: r.is_main, drawTime: r.draw_time, createdAt: r.created_at}));
    newCache.results = results.rows.map(r => ({...r, lotteryId: r.lottery_id, resultText: r.result_text, updatedAt: r.updated_at, deletedAt: r.deleted_at, scheduledFor: r.scheduled_for}));
    newCache.purchases = purchases.rows.filter(r => !r.round_ended_at).map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, buyerName: r.buyer_name, requestId: r.request_id, createdAt: r.created_at, roundEndedAt: r.round_ended_at}));
    newCache.purchaseHistory = purchases.rows.filter(r => !!r.round_ended_at).map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, buyerName: r.buyer_name, requestId: r.request_id, createdAt: r.created_at, roundEndedAt: r.round_ended_at}));
    newCache.users = users.rows.map(r => ({...r, userCode: r.user_code, passwordHash: r.password_hash, sessionVersion: r.session_version, recoveryCodeHash: r.recovery_code_hash, createdAt: r.created_at}));
    newCache.watchedNumbers = watchedNumbers.rows.map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, createdAt: r.created_at}));
    newCache.notifications = notifications.rows.map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, resultDate: r.result_date, readAt: r.read_at, createdAt: r.created_at}));
    newCache.auditLog = auditLog.rows.map(r => ({...r}));
    newCache.specialLotteries = specialLotteries.rows.map(r => ({...r, drawTime: r.draw_time, createdAt: r.created_at}));
    newCache.specialResults = specialResults.rows.map(r => ({...r, lotteryId: r.lottery_id, resultText: r.result_text, updatedAt: r.updated_at, deletedAt: r.deleted_at, scheduledFor: r.scheduled_for}));
    newCache.specialPurchases = specialPurchases.rows.filter(r => !r.round_ended_at).map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, buyerName: r.buyer_name, requestId: r.request_id, createdAt: r.created_at, roundEndedAt: r.round_ended_at}));
    newCache.specialPurchaseHistory = specialPurchases.rows.filter(r => !!r.round_ended_at).map(r => ({...r, userId: r.user_id, lotteryId: r.lottery_id, buyerName: r.buyer_name, requestId: r.request_id, createdAt: r.created_at, roundEndedAt: r.round_ended_at}));

    settingsRows.rows.forEach(r => {
      newCache.settings[r.key] = r.value;
    });

    cache = newCache;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// SQL HELPERS
// ---------------------------------------------------------------------------
function snakeCase(key) {
  return key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
}

function buildWhere(table, query) {
  if (!query || Object.keys(query).length === 0) return { clause: '', values: [] };
  const keys = Object.keys(query);
  const clauses = keys.map((k, i) => `${snakeCase(k)} = $${i + 1}`);
  return { clause: 'WHERE ' + clauses.join(' AND '), values: keys.map(k => query[k]) };
}

function buildUpdate(table, updates) {
  const keys = Object.keys(updates);
  const sets = keys.map((k, i) => `${snakeCase(k)} = $${i + 1}`);
  return { clause: sets.join(', '), values: keys.map(k => updates[k]) };
}

async function sqlSelect(table, where, options) {
  if (!postgresEnabled || !pool) return [];
  const { clause, values } = buildWhere(table, where);
  let sql = `SELECT * FROM ${table} ${clause}`;
  if (options.sortBy) {
    const cols = Array.isArray(options.sortBy) ? options.sortBy : [options.sortBy];
    sql += ' ORDER BY ' + cols.map(snakeCase).join(', ');
  }
  if (options.reverse) sql += ' DESC';
  const r = await pool.query(sql, values);
  return r.rows;
}

async function sqlInsert(table, item) {
  if (!postgresEnabled || !pool) return;
  const keys = Object.keys(item).filter(k => item[k] !== undefined);
  const cols = keys.map(snakeCase);
  const vals = keys.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')})`;
  await pool.query(sql, keys.map(k => item[k]));
}

async function sqlUpdate(table, where, updates) {
  if (!postgresEnabled || !pool) return;
  const { clause: whereClause, values: whereValues } = buildWhere(table, where);
  const { clause: setClause, values: setValues } = buildUpdate(table, updates);
  const sql = `UPDATE ${table} SET ${setClause} ${whereClause}`;
  await pool.query(sql, [...setValues, ...whereValues]);
}

async function sqlDelete(table, where) {
  if (!postgresEnabled || !pool) return;
  const { clause, values } = buildWhere(table, where);
  await pool.query(`DELETE FROM ${table} ${clause}`, values);
}

// ---------------------------------------------------------------------------
// SETTINGS HELPERS
// ---------------------------------------------------------------------------
async function loadSettings() {
  if (!postgresEnabled || !pool) return clone(defaults.settings);
  const r = await pool.query('SELECT key, value FROM settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}

async function saveSettings(settingsObj) {
  if (!postgresEnabled || !pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of Object.keys(settingsObj)) {
      await client.query(`INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()`, [key, JSON.stringify(settingsObj[key])]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// CHAIN CLASS (preserves existing API)
// ---------------------------------------------------------------------------
class Chain {
  constructor(value, rootPath = null, queryContext = null) {
    this.valueData = value;
    this.rootPath = rootPath;
    this.queryContext = queryContext || {};
  }

  value() { return clone(this.valueData); }

  find(queryOrFn) {
    const arr = Array.isArray(this.valueData) ? this.valueData : [];
    const predicate = typeof queryOrFn === 'function' ? queryOrFn : x => matches(x, queryOrFn);
    const found = arr.find(predicate);
    return new Chain(found, this.rootPath, { ...this.queryContext, findQuery: queryOrFn, found });
  }

  filter(queryOrFn) {
    const arr = Array.isArray(this.valueData) ? this.valueData : [];
    const out = typeof queryOrFn === 'function' ? arr.filter(queryOrFn) : arr.filter(x => matches(x, queryOrFn));
    return new Chain(out, this.rootPath, { ...this.queryContext, filterQuery: queryOrFn });
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
    return new Chain(out, this.rootPath, { ...this.queryContext, sortBy: keys });
  }

  reverse() { return new Chain((this.valueData || []).slice().reverse(), this.rootPath, { ...this.queryContext, reverse: true }); }

  slice(...args) { return new Chain((this.valueData || []).slice(...args), this.rootPath, this.queryContext); }

  push(item) {
    if (Array.isArray(this.valueData)) {
      this.valueData.push(clone(item));
    }
    return new Chain(this.valueData, this.rootPath, { ...this.queryContext, pushItem: item });
  }

  assign(obj) {
    if (this.valueData && typeof this.valueData === 'object') {
      Object.assign(this.valueData, clone(obj));
    }
    return new Chain(this.valueData, this.rootPath, { ...this.queryContext, assignObj: obj });
  }

  remove(query) {
    if (!Array.isArray(this.valueData)) return this;
    const kept = this.valueData.filter(x => !matches(x, query));
    this.valueData.length = 0;
    kept.forEach(x => this.valueData.push(x));
    return new Chain(this.valueData, this.rootPath, { ...this.queryContext, removeQuery: query });
  }

  write() {
    return withWriteLock(async () => {
      if (!postgresEnabled || !pool) {
        // Development JSON fallback
        if (jsonDb) { jsonDb.setState(cache); jsonDb.write(); }
        return this;
      }

      const table = TABLE_MAP[this.rootPath];
      const qc = this.queryContext;

      // Handle settings
      if (this.rootPath === 'settings' || String(this.rootPath).startsWith('settings.')) {
        await saveSettings(cache.settings);
        await backupAppState();
        return this;
      }

      if (!table) {
        // Fallback: backup to app_state for unknown paths
        await backupAppState();
        return this;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (qc.pushItem) {
          // INSERT
          const item = qc.pushItem;
          if (this.rootPath === 'purchases' || this.rootPath === 'specialPurchases') {
            item.roundEndedAt = null;
          }
          await sqlInsert(table, item);
        } else if (qc.removeQuery) {
          // DELETE
          const where = {};
          if (qc.findQuery && typeof qc.findQuery === 'object') Object.assign(where, qc.findQuery);
          else if (qc.removeQuery && typeof qc.removeQuery === 'object') Object.assign(where, qc.removeQuery);
          if (this.rootPath === 'results' || this.rootPath === 'specialResults') {
            // Soft delete for results
            await client.query(`UPDATE ${table} SET deleted_at = now() ${buildWhere(table, where).clause ? buildWhere(table, where).clause : ''}`, buildWhere(table, where).values);
          } else {
            await client.query(`DELETE FROM ${table} ${buildWhere(table, where).clause}`, buildWhere(table, where).values);
          }
        } else if (qc.assignObj) {
          // UPDATE
          const where = {};
          if (qc.findQuery && typeof qc.findQuery === 'object') Object.assign(where, qc.findQuery);
          const updates = {};
          for (const k of Object.keys(qc.assignObj)) {
            if (k === 'id') continue;
            updates[k] = qc.assignObj[k];
          }
          if (Object.keys(where).length && Object.keys(updates).length) {
            await sqlUpdate(table, where, updates);
          } else if (Object.keys(updates).length && qc.found && qc.found.id) {
            await sqlUpdate(table, { id: qc.found.id }, updates);
          }
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // Refresh cache atomically after successful commit
      await refreshCache();
      await backupAppState();
      return this;
    });
  }
}

// ---------------------------------------------------------------------------
// DB GET / SET / DEFAULTS
// ---------------------------------------------------------------------------
function dbGet(p) {
  const val = getPath(cache, p);
  return new Chain(clone(val), p);
}

function dbSet(p, v) {
  setPath(cache, p, v);
  return new Chain(getPath(cache, p), p);
}

function dbDefaults(o) {
  cache = { ...JSON.parse(JSON.stringify(o)), ...cache };
  return new Chain(clone(cache));
}

// ---------------------------------------------------------------------------
// APP_STATE BACKUP (lightweight cache — never read as primary)
// ---------------------------------------------------------------------------
async function backupAppState() {
  if (!postgresEnabled || !pool) return;
  const snapshot = {
    lotteries: cache.lotteries,
    results: cache.results,
    purchases: cache.purchases,
    purchaseHistory: cache.purchaseHistory,
    users: cache.users,
    watchedNumbers: cache.watchedNumbers,
    specialLotteries: cache.specialLotteries,
    specialResults: cache.specialResults,
    specialPurchases: cache.specialPurchases,
    specialPurchaseHistory: cache.specialPurchaseHistory,
    notifications: cache.notifications,
    settings: cache.settings,
    auditLog: cache.auditLog,
    analytics: cache.analytics,
    visitorSessions: cache.visitorSessions,
  };
  try {
    await pool.query(`UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE id=1`, [JSON.stringify(snapshot)]);
  } catch (e) {
    console.error('App state backup failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// INITIALIZATION
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MIGRATION: Copy data from legacy app_state JSON blob to new normalized tables
// This runs once on first boot after the Part 2 update.
// ---------------------------------------------------------------------------
async function migrateFromLegacyAppState() {
  if (!postgresEnabled || !pool) return;

  // Check if we already have data in the new tables
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*) FROM lotteries'),
    pool.query('SELECT COUNT(*) FROM settings'),
  ]);
  const hasLotteries = parseInt(counts[0].rows[0].count) > 0;
  const hasSettings = parseInt(counts[1].rows[0].count) > 0;

  // If both tables have data, migration already happened
  if (hasLotteries && hasSettings) return;

  // Read the legacy app_state
  const legacy = await pool.query('SELECT data FROM app_state WHERE id=1');
  if (!legacy.rows.length || !legacy.rows[0].data) {
    console.log('No legacy app_state found. Fresh install — using defaults.');
    return;
  }

  const old = legacy.rows[0].data;
  console.log('Migrating data from legacy app_state to normalized tables...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Migrate settings
    if (old.settings && !hasSettings) {
      for (const key of Object.keys(old.settings)) {
        await client.query(
          `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()`,
          [key, JSON.stringify(old.settings[key])]
        );
      }
    }

    // Migrate lotteries
    if (old.lotteries && Array.isArray(old.lotteries) && !hasLotteries) {
      for (const l of old.lotteries) {
        await client.query(
          `INSERT INTO lotteries(id,name,slug,draw_time,starred,is_main,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
          [l.id, l.name, l.slug, l.drawTime || l.draw_time, !!l.starred, !!l.isMain, l.createdAt || l.created_at || new Date().toISOString()]
        );
      }
    }

    // Migrate results
    if (old.results && Array.isArray(old.results)) {
      for (const r of old.results) {
        await client.query(
          `INSERT INTO results(id,lottery_id,date,result_text,updated_at,deleted_at,published,scheduled_for) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
          [r.id, r.lotteryId || r.lottery_id, r.date, r.resultText || r.result_text, r.updatedAt || r.updated_at, r.deletedAt || r.deleted_at, r.published !== false, r.scheduledFor || r.scheduled_for]
        );
      }
    }

    // Migrate users
    if (old.users && Array.isArray(old.users)) {
      for (const u of old.users) {
        await client.query(
          `INSERT INTO users(id,name,user_code,password_hash,active,session_version,recovery_code_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
          [u.id, u.name, u.userCode || u.user_code, u.passwordHash || u.password_hash, u.active !== false, u.sessionVersion || u.session_version || 0, u.recoveryCodeHash || u.recovery_code_hash, u.createdAt || u.created_at || new Date().toISOString()]
        );
      }
    }

    // Migrate purchases
    if (old.purchases && Array.isArray(old.purchases)) {
      for (const p of old.purchases) {
        await client.query(
          `INSERT INTO purchases(id,user_id,lottery_id,number,buyer_name,tickets,amount,request_id,created_at,round_ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
          [p.id, p.userId || p.user_id, p.lotteryId || p.lottery_id, p.number, p.buyerName || p.buyer_name, p.tickets || 1, p.amount || 0, p.requestId || p.request_id, p.createdAt || p.created_at || new Date().toISOString(), p.roundEndedAt || p.round_ended_at]
        );
      }
    }

    // Migrate watched numbers
    if (old.watchedNumbers && Array.isArray(old.watchedNumbers)) {
      for (const w of old.watchedNumbers) {
        await client.query(
          `INSERT INTO watched_numbers(id,user_id,lottery_id,number,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
          [w.id, w.userId || w.user_id, w.lotteryId || w.lottery_id, w.number, w.createdAt || w.created_at || new Date().toISOString()]
        );
      }
    }

    // Migrate notifications
    if (old.notifications && Array.isArray(old.notifications)) {
      for (const n of old.notifications) {
        await client.query(
          `INSERT INTO notifications(id,user_id,lottery_id,result_date,number,title,message,created_at,read_at,type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
          [n.id, n.userId || n.user_id, n.lotteryId || n.lottery_id, n.resultDate || n.result_date, n.number, n.title, n.message, n.createdAt || n.created_at || new Date().toISOString(), n.readAt || n.read_at, n.type]
        );
      }
    }

    // Migrate audit log
    if (old.auditLog && Array.isArray(old.auditLog)) {
      for (const a of old.auditLog.slice(0, 500)) {
        await client.query(
          `INSERT INTO audit_log(id,action,detail,ip,timestamp) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
          [a.id, a.action, a.detail, a.ip, a.timestamp || new Date().toISOString()]
        );
      }
    }

    // Migrate special lotteries
    if (old.specialLotteries && Array.isArray(old.specialLotteries)) {
      for (const l of old.specialLotteries) {
        await client.query(
          `INSERT INTO special_lotteries(id,name,slug,draw_time,starred,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
          [l.id, l.name, l.slug, l.drawTime || l.draw_time, !!l.starred, l.createdAt || l.created_at || new Date().toISOString()]
        );
      }
    }

    // Migrate special results
    if (old.specialResults && Array.isArray(old.specialResults)) {
      for (const r of old.specialResults) {
        await client.query(
          `INSERT INTO special_results(id,lottery_id,date,result_text,updated_at,deleted_at,published,scheduled_for) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
          [r.id, r.lotteryId || r.lottery_id, r.date, r.resultText || r.result_text, r.updatedAt || r.updated_at, r.deletedAt || r.deleted_at, r.published !== false, r.scheduledFor || r.scheduled_for]
        );
      }
    }

    // Migrate special purchases
    if (old.specialPurchases && Array.isArray(old.specialPurchases)) {
      for (const p of old.specialPurchases) {
        await client.query(
          `INSERT INTO special_purchases(id,user_id,lottery_id,number,buyer_name,tickets,amount,request_id,created_at,round_ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
          [p.id, p.userId || p.user_id, p.lotteryId || p.lottery_id, p.number, p.buyerName || p.buyer_name, p.tickets || 1, p.amount || 0, p.requestId || p.request_id, p.createdAt || p.created_at || new Date().toISOString(), p.roundEndedAt || p.round_ended_at]
        );
      }
    }

    await client.query('COMMIT');
    console.log('Migration from legacy app_state completed successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e);
    throw e;
  } finally {
    client.release();
  }
}

async function initPostgres() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10 });
  await pool.query('SELECT 1');
  await createNormalizedTables();
  await migrateFromLegacyAppState();

  // Seed settings if empty
  const settingsCount = await pool.query('SELECT COUNT(*) FROM settings');
  if (parseInt(settingsCount.rows[0].count) === 0) {
    for (const key of Object.keys(defaults.settings)) {
      await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2)`, [key, JSON.stringify(defaults.settings[key])]);
    }
  }

  // Seed 2FA from env on first init
  const totpRow = await pool.query(`SELECT value FROM settings WHERE key='adminTotpSecret'`);
  if (process.env.ADMIN_TOTP_SECRET && (!totpRow.rows.length || !totpRow.rows[0].value)) {
    await pool.query(`INSERT INTO settings(key,value) VALUES('adminTotpSecret',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(process.env.ADMIN_TOTP_SECRET)]);
  }

  await refreshCache();
  await ensureDefaults();
}

async function ensureDefaults() {
  // Ensure admin password exists
  const adminHash = await pool.query(`SELECT value FROM settings WHERE key='adminPasswordHash'`);
  if (!adminHash.rows.length || !adminHash.rows[0].value) {
    const initialAdminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
    if (!initialAdminPassword) {
      throw new Error('ADMIN_PASSWORD is required to create the initial admin account; no default password is allowed.');
    }
    const hashed = hashPassword(initialAdminPassword);
    await pool.query(`INSERT INTO settings(key,value) VALUES('adminPasswordHash',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(hashed)]);
  }

  // Ensure other settings exist
  const requiredSettings = ['contactNumber','contactLabel','contactType','adminSessionVersion','adminTotpSecret','backupVersion'];
  for (const key of requiredSettings) {
    const r = await pool.query(`SELECT value FROM settings WHERE key=$1`, [key]);
    if (!r.rows.length) {
      const defaultVal = defaults.settings[key] ?? '';
      await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [key, JSON.stringify(defaultVal)]);
    }
  }

  await refreshCache();
}

// ---------------------------------------------------------------------------
// CLEANUP
// ---------------------------------------------------------------------------
function cleanupOldResults() {
  if (!postgresEnabled || !pool) return 0;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 40); const c = cutoff.toISOString().slice(0,10);
  return withWriteLock(async () => {
    const r = await pool.query(`UPDATE results SET deleted_at = now(), auto_deleted = true WHERE deleted_at IS NULL AND date < $1 RETURNING id`, [c]);
    const n = r.rows.length;
    if (n) {
      await pool.query(`UPDATE special_results SET deleted_at = now(), auto_deleted = true WHERE deleted_at IS NULL AND date < $1`, [c]);
      await refreshCache();
      await backupAppState();
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// VISITS & ANALYTICS
// ---------------------------------------------------------------------------
async function recordVisit(visitorId, dateStr) {
  if (!postgresEnabled || !pool) {
    const key = `analytics.${dateStr}`; const cur = Number(getPath(cache, key) || 0) + 1; setPath(cache, key, cur); return { visits: cur, uniqueSessions: cur };
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

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------
function notifyResultWatchers(lottery, result) {
  const publishedNumbers = (result.resultText.match(/\d{1,2}/g) || []).map((n) => n.padStart(2, '0'));
  const matchingWatches = (getPath(cache, 'watchedNumbers') || []).filter(
    (w) => w.lotteryId === lottery.id && publishedNumbers.includes(w.number)
  );
  matchingWatches.forEach(async (w) => {
    const user = (getPath(cache, 'users') || []).find(u => u.id === w.userId);
    if (!user || user.notificationsEnabled === false) return;
    const already = (getPath(cache, 'notifications') || []).find(n =>
      n.userId === w.userId && n.lotteryId === lottery.id && n.resultDate === result.date && n.number === w.number
    );
    if (already) return;

    const notification = {
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
    };

    // Add to cache immediately
    if (!cache.notifications) cache.notifications = [];
    cache.notifications.push(notification);

    // Persist to PostgreSQL
    if (postgresEnabled && pool) {
      try {
        await pool.query(`INSERT INTO notifications(id,user_id,lottery_id,result_date,number,title,message,created_at,read_at,type) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9)`, [notification.id, notification.userId, notification.lotteryId, notification.resultDate, notification.number, notification.title, notification.message, notification.readAt, notification.type]);
      } catch (e) { console.error('Notification insert failed:', e.message); }
    }

    // Web push
    try {
      const webpush = require('web-push');
      const publicKey = process.env.VAPID_PUBLIC_KEY;
      const privateKey = process.env.VAPID_PRIVATE_KEY;
      const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
      if (publicKey && privateKey && user.pushSubscription) {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        webpush.sendNotification(user.pushSubscription, JSON.stringify({
          title: 'Result notification',
          body: `${lottery.name}: your followed number ${w.number} appeared in the result for ${result.date}.`,
          url: '/account',
        })).catch(() => {});
      }
    } catch (e) { /* optional */ }
  });
}

// ---------------------------------------------------------------------------
// SCHEDULED PUBLISHING
// ---------------------------------------------------------------------------
async function publishDueScheduledResults() {
  const nowIso = new Date().toISOString();
  const due = (getPath(cache, 'results') || []).filter(
    (r) => r.published === false && r.scheduledFor && r.scheduledFor <= nowIso && !r.deletedAt
  );
  for (const result of due) {
    await withWriteLock(async () => {
      await pool.query(`UPDATE results SET published=true, updated_at=now() WHERE id=$1`, [result.id]);
    });
    const lottery = (getPath(cache, 'lotteries') || []).find(l => l.id === result.lotteryId);
    if (lottery) { notifyResultWatchers(lottery, result); await startNewRound(result.lotteryId); }
  }
  if (due.length) { await refreshCache(); await backupAppState(); }
}

async function publishDueScheduledSpecialResults() {
  const nowIso = new Date().toISOString();
  const due = (getPath(cache, 'specialResults') || []).filter(
    (r) => r.published === false && r.scheduledFor && r.scheduledFor <= nowIso && !r.deletedAt
  );
  for (const result of due) {
    await withWriteLock(async () => {
      await pool.query(`UPDATE special_results SET published=true, updated_at=now() WHERE id=$1`, [result.id]);
    });
    await startNewSpecialRound(result.lotteryId);
  }
  if (due.length) { await refreshCache(); await backupAppState(); }
}

// ---------------------------------------------------------------------------
// AUTO STAR
// ---------------------------------------------------------------------------
function parseDrawMinutesForStar(drawTime) {
  if (!drawTime) return null;
  const raw = String(drawTime).trim().toUpperCase().replace(/\s+/g, ' ');
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  let h, min, ap;
  if (m) { h = Number(m[1]); min = Number(m[2]); ap = m[3]; }
  else {
    m = raw.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (!m) return null;
    h = Number(m[1]); min = 0; ap = m[2];
  }
  if (min > 59) return null;
  if (ap) {
    if (h >= 13 && h <= 23) { /* legacy */ }
    else { if (h < 1 || h > 12) return null; if (h === 12) h = 0; if (ap === 'PM') h += 12; }
  }
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

function zonedNowForStar(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

async function runAutoStar(lotteriesKey, resultsKey, starModeSettingPath) {
  const mode = getPath(cache, starModeSettingPath);
  if (mode !== 'auto') return;

  const lotteries = getPath(cache, lotteriesKey) || [];
  if (!lotteries.length) return;

  const tz = process.env.LOTTERY_TIMEZONE || 'Asia/Kolkata';
  const now = zonedNowForStar(tz);
  const today = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const nowMinutes = now.hour * 60 + now.minute;
  const nowMs = Date.now();
  const results = getPath(cache, resultsKey) || [];

  let recent = null;
  lotteries.forEach((lottery) => {
    const todayResult = results.find((r) => r.lotteryId === lottery.id && r.date === today && !r.deletedAt && r.published !== false);
    if (!todayResult || !todayResult.updatedAt) return;
    const publishedMs = new Date(todayResult.updatedAt).getTime();
    if (!Number.isFinite(publishedMs)) return;
    const ageMinutes = (nowMs - publishedMs) / 60000;
    if (ageMinutes >= 0 && ageMinutes <= 15 && (!recent || publishedMs > recent.publishedMs)) {
      recent = { lottery, publishedMs };
    }
  });

  let winnerId = null;
  if (recent) {
    winnerId = recent.lottery.id;
  } else {
    let best = null;
    lotteries.forEach((lottery) => {
      const drawMinutes = parseDrawMinutesForStar(lottery.drawTime);
      if (drawMinutes == null) return;
      const distance = ((drawMinutes - nowMinutes) % 1440 + 1440) % 1440;
      if (!best || distance < best.distance) best = { lottery, distance };
    });
    if (best) winnerId = best.lottery.id;
  }
  if (!winnerId) return;

  const alreadyCorrect = lotteries.every((l) => !!l.starred === (l.id === winnerId));
  if (alreadyCorrect) return;

  const table = lotteriesKey === 'lotteries' ? 'lotteries' : 'special_lotteries';
  await withWriteLock(async () => {
    for (const l of lotteries) {
      const shouldBeStarred = l.id === winnerId;
      if (!!l.starred !== shouldBeStarred) {
        await pool.query(`UPDATE ${table} SET starred=$1 WHERE id=$2`, [shouldBeStarred, l.id]);
      }
    }
  });
  await refreshCache();
  await backupAppState();
}

async function applyAutoStar() { return runAutoStar('lotteries', 'results', 'settings.starMode'); }
async function applyAutoSpecialStar() { return runAutoStar('specialLotteries', 'specialResults', 'settings.specialStarMode'); }

// ---------------------------------------------------------------------------
// ROUND MANAGEMENT
// ---------------------------------------------------------------------------
async function startNewRound(lotteryId) {
  const now = new Date().toISOString();
  const toArchive = (getPath(cache, 'purchases') || []).filter(p => p.lotteryId === lotteryId);
  if (toArchive.length) {
    await withWriteLock(async () => {
      await pool.query(`UPDATE purchases SET round_ended_at=now() WHERE lottery_id=$1 AND round_ended_at IS NULL`, [lotteryId]);
    });
  }
  await withWriteLock(async () => {
    await pool.query(`UPDATE lotteries SET current_round_start_at=now() WHERE id=$1`, [lotteryId]);
  });
  await refreshCache();
  await backupAppState();
}

async function startNewSpecialRound(lotteryId) {
  const now = new Date().toISOString();
  const toArchive = (getPath(cache, 'specialPurchases') || []).filter(p => p.lotteryId === lotteryId);
  if (toArchive.length) {
    await withWriteLock(async () => {
      await pool.query(`UPDATE special_purchases SET round_ended_at=now() WHERE lottery_id=$1 AND round_ended_at IS NULL`, [lotteryId]);
    });
  }
  await withWriteLock(async () => {
    await pool.query(`UPDATE special_lotteries SET current_round_start_at=now() WHERE id=$1`, [lotteryId]);
  });
  await refreshCache();
  await backupAppState();
}

function allPurchasesEverMade() {
  return (getPath(cache, 'purchases') || []).concat(getPath(cache, 'purchaseHistory') || []);
}

function allSpecialPurchasesEverMade() {
  return (getPath(cache, 'specialPurchases') || []).concat(getPath(cache, 'specialPurchaseHistory') || []);
}

// ---------------------------------------------------------------------------
// HEALTH & BACKUP
// ---------------------------------------------------------------------------
async function healthCheck() {
  if (!postgresEnabled || !pool) return { ok: false, database: 'not-configured' };
  try { await pool.query('SELECT 1'); return { ok: true, database: 'postgresql' }; }
  catch (e) { console.error('Database health check failed:', e.message); return { ok: false, database: 'postgresql' }; }
}

async function encryptedBackup() {
  if (!postgresEnabled || !pool) throw new Error('PostgreSQL is required for backups.');
  const keyText = process.env.BACKUP_ENCRYPTION_KEY; if (!keyText) throw new Error('BACKUP_ENCRYPTION_KEY is not configured.');
  const safe = clone(cache);
  (safe.users || []).forEach(u => { delete u.passwordHash; delete u.recoveryCodeHash; });
  if (safe.settings) { delete safe.settings.adminPasswordHash; delete safe.settings.adminTotpSecret; }
  const key = crypto.createHash('sha256').update(keyText).digest(); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(safe))), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

// ---------------------------------------------------------------------------
// MODULE EXPORTS
// ---------------------------------------------------------------------------
const db = {
  getInitError: () => initError,
  get: dbGet,
  set: dbSet,
  defaults: dbDefaults,
  value: () => clone(cache),
  getState: () => clone(cache),
  cleanupOldResults,
  recordVisit,
  getVisitStats,
  healthCheck,
  encryptedBackup,
  getPool: () => pool,
  ready,
  isPostgres: () => postgresEnabled,
  flush: async () => { await backupAppState(); },
  persistNow: async () => { await refreshCache(); await backupAppState(); },
  notifyResultWatchers,
  publishDueScheduledResults,
  publishDueScheduledSpecialResults,
  applyAutoStar,
  applyAutoSpecialStar,
  startNewRound,
  startNewSpecialRound,
  allPurchasesEverMade,
  allSpecialPurchasesEverMade,
};

(async () => {
  try {
    if (productionWithoutDb) throw new Error('DATABASE_URL is required in production. JSON fallback is disabled.');
    if (process.env.NODE_ENV === 'production' && !process.env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY is required in production.');
    if (postgresEnabled) await initPostgres();
    readyResolve();
  } catch (err) {
    console.error('Database initialization failed:', err); initError = err; process.exitCode = 1; readyResolve();
  }
})();

module.exports = db;
