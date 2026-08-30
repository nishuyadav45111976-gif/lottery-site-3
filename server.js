/*
 * RATE LIMITING & CSP CHANGES
 * - express-rate-limit protects login, ticket submission, and admin result endpoints.
 * - Login pages (/login, /admin/login): 5 attempts per 15 min per IP.
 * - Ticket submissions: 20 per 15 min per user ID.
 * - Admin result updates: 10 per 15 min per admin.
 * - Content Security Policy is now enforced (was previously disabled).
 * - Trust proxy hops are read from TRUST_PROXY_HOPS env var (default 1).
 */

require("dotenv").config();

if (process.env.NODE_ENV !== "production") {
  throw new Error("NODE_ENV=production is required for Render deployment");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production");
}
if (process.env.DATABASE_SSL !== "true") {
  throw new Error("DATABASE_SSL=true is required in production");
}
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}
if (process.env.COOKIE_SECURE !== "true") {
  throw new Error("COOKIE_SECURE=true is required in production");
}
if (!process.env.BACKUP_ENCRYPTION_KEY) {
  throw new Error("BACKUP_ENCRYPTION_KEY is required in production");
}
if (process.env.LOTTERY_TIMEZONE !== "Asia/Kolkata") {
  throw new Error("LOTTERY_TIMEZONE=Asia/Kolkata is required in production");
}

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const db = require('./db');
const { digitsOnly } = require('./utils');
const { translator } = require('./locales');

const publicRoutes = require('./routes-public');
const adminRoutes = require('./routes-admin');
const userRoutes = require('./routes-user').router;

const app = express();

// Trust proxy hops configurable via env (default 1) for accurate req.ip behind reverse proxies.
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
app.set('trust proxy', Number.isNaN(trustProxyHops) ? 1 : trustProxyHops);

app.set('view engine', 'ejs');
app.set('views', __dirname);

// Production security headers with proper CSP.
// FIX: Added useDefaults: false so custom directives fully override defaults.
// This allows inline onclick handlers used by the admin three-dot menu.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Production must use real secrets and a persistent database. Never fall back
// to example/default credentials or a fixed session secret.
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = String(process.env.SESSION_SECRET || '').trim();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '5m' : 0 }));

app.get('/health', async (req, res) => {
  const result = await db.healthCheck();
  res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ok' : 'degraded', database: result.database });
});

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).send('Too many login attempts. Please try again after 15 minutes.');
  }
});

const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.userId) ? req.session.userId : req.ip,
  handler: (req, res) => {
    res.status(429).send('Too many ticket submissions. Please try again later.');
  }
});

const adminResultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).send('Too many result updates. Please try again later.');
  }
});

// Apply rate limiters
app.use('/admin/login', loginLimiter);
app.use('/login', loginLimiter);
app.use('/lottery/:id/purchases-multi', ticketLimiter);
app.use('/lottery/:id/purchases/:number', ticketLimiter);
app.use('/account/tickets/:id/edit', ticketLimiter);
app.use('/admin/lottery/:id/result', adminResultLimiter);
app.use('/admin/special/lottery/:id/result', adminResultLimiter);

const sessionPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 5 }) : null;
const sessionOptions = {
  secret: sessionSecret || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' },
};
if (sessionPool) sessionOptions.store = new PgSession({ pool: sessionPool, tableName: 'user_sessions', createTableIfMissing: true });
app.use(session(sessionOptions));

// Per-session CSRF token and validation for all state-changing browser requests.
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const exempt = req.path === '/login' || req.path === '/admin/login';
    if (!exempt) {
      const supplied = req.body && req.body._csrf || req.get('x-csrf-token');
      const a = Buffer.from(String(supplied || '')); const b = Buffer.from(String(req.session.csrfToken || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).send('Invalid security token. Please refresh the page and try again.');
      }
    }
  }
  next();
});

// Make the site name (and other shared values) available to every view
app.use((req, res, next) => {
  res.locals.siteName = db.get('settings.siteName').value() || 'Haryana Results';
  res.locals.contactNumber = db.get('settings.contactNumber').value() || '';
  res.locals.contactLabel = db.get('settings.contactLabel').value() || 'Help & Queries';
  res.locals.contactType = db.get('settings.contactType').value() || 'call';
  res.locals.contactDigits = digitsOnly(res.locals.contactNumber);
  res.locals.currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.locals.noIndex = req.path.startsWith('/admin') || req.path.startsWith('/account') || req.path === '/login' || req.path === '/recover';
  res.locals.isAdminPage = req.path.startsWith('/admin');
  res.locals.isAdminNavPage = req.path.startsWith('/admin') && req.path !== '/admin/login';
  res.locals.enableAdminInstall = req.path.startsWith('/admin') && req.path !== '/admin/login';
  res.locals.userSession = !!(req.session && req.session.userId);

  const lang = (req.session && req.session.lang === 'hi') ? 'hi' : 'en';
  res.locals.lang = lang;
  res.locals.t = translator(lang);
  res.locals.enableServiceWorker = !req.path.startsWith('/admin') && !req.path.startsWith('/account') && req.path !== '/login' && req.path !== '/recover';
  res.locals.hasSpecialLotteries = (db.get('specialLotteries').value() || []).length > 0;
  res.locals.isUserArea = req.path === '/login' || req.path.startsWith('/account') || req.path === '/recover';
  req.session.visitorId = req.session.visitorId || crypto.randomUUID();
  res.locals.visitorId = req.session.visitorId;

  next();
});

app.use('/', publicRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

// Central production error handler.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled request error:', err && err.stack ? err.stack : err);
  res.status(500).send('Something went wrong while saving that change. Please try again. If it keeps happening, check the server logs.');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Scheduled result publishing
setInterval(() => {
  db.publishDueScheduledResults().catch((e) => console.error('Scheduled publish check failed:', e));
  db.publishDueScheduledSpecialResults().catch((e) => console.error('Scheduled special publish check failed:', e));
}, 30 * 1000);

// Auto-star
setInterval(() => {
  db.applyAutoStar().catch((e) => console.error('Auto-star check failed:', e));
  db.applyAutoSpecialStar().catch((e) => console.error('Special auto-star check failed:', e));
}, 30 * 1000);

// Cleanup old results
const removedOnStartup = db.cleanupOldResults();
if (removedOnStartup > 0) {
  console.log(`Moved ${removedOnStartup} result(s) older than 40 days into the trash.`);
}
setInterval(() => {
  db.cleanupOldResults();
}, 1000 * 60 * 60 * 24);

// Automated backups
if (process.env.BACKUP_INTERVAL_HOURS && Number(process.env.BACKUP_INTERVAL_HOURS) > 0) {
  const interval = Number(process.env.BACKUP_INTERVAL_HOURS) * 60 * 60 * 1000;
  const runBackup = () => { const { spawn } = require('child_process'); const child = spawn(process.execPath, [path.join(__dirname,'scripts-backup-postgres.js')], { stdio:'inherit' }); child.on('error', e => console.error('Automated backup failed:', e.message)); };
  setTimeout(runBackup, 10000);
  setInterval(runBackup, interval);
}

const PORT = process.env.PORT || 3000;
db.ready.then(() => {
  if (process.env.NODE_ENV === 'production' && db.getInitError()) { console.error('Production database initialization failed. Server will not start.'); process.exit(1); }
  app.listen(PORT, () => {
    console.log(`Lottery results site running at http://localhost:${PORT}`);
    console.log(`Database mode: ${db.isPostgres() ? 'PostgreSQL' : 'Development JSON mode'}`);
  });
});
process.on('SIGTERM', async () => { await db.flush(); process.exit(0); });
process.on('SIGINT', async () => { await db.flush(); process.exit(0); });
