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

// Trust the platform's reverse proxy (Replit, Render, etc.) so req.ip reflects
// the real visitor instead of the proxy — needed for accurate login lockouts.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', __dirname);

// Production security headers.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Production must use real secrets and a persistent database. Never fall back
// to example/default credentials or a fixed session secret.
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = String(process.env.SESSION_SECRET || '').trim();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));

app.get('/health', async (req, res) => {
  const result = await db.healthCheck();
  res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ok' : 'degraded', database: result.database });
});

const sessionPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 5 }) : null;
const sessionOptions = {
  // A real secret is required by the application; there is no hard-coded fallback.
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
// without passing them manually on every single render() call
app.use((req, res, next) => {
  res.locals.siteName = db.get('settings.siteName').value() || 'Haryana Results';
  res.locals.contactNumber = db.get('settings.contactNumber').value() || '';
  res.locals.contactLabel = db.get('settings.contactLabel').value() || 'Help & Queries';
  res.locals.contactType = db.get('settings.contactType').value() || 'call';
  res.locals.contactDigits = digitsOnly(res.locals.contactNumber);
  res.locals.currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.locals.noIndex = req.path.startsWith('/admin') || req.path.startsWith('/account') || req.path === '/login' || req.path === '/recover';
  // Lets shared partials (header/footer) know we're inside the admin panel
  // without every single admin view having to pass it in manually.
  res.locals.isAdminPage = req.path.startsWith('/admin');
  res.locals.isAdminNavPage = req.path.startsWith('/admin') && req.path !== '/admin/login';
  // Lets the admin panel be installed to the home screen as its own app,
  // separate from the public site's installability (enableServiceWorker
  // below, which deliberately excludes /admin).
  res.locals.enableAdminInstall = req.path.startsWith('/admin') && req.path !== '/admin/login';
  res.locals.userSession = !!(req.session && req.session.userId);

  // Language for the public site (English/Hindi). Persisted in the session so
  // it sticks across pages without needing a cookie-parsing dependency.
  const lang = (req.session && req.session.lang === 'hi') ? 'hi' : 'en';
  res.locals.lang = lang;
  res.locals.t = translator(lang);
  res.locals.enableServiceWorker = !req.path.startsWith('/admin') && !req.path.startsWith('/account') && req.path !== '/login' && req.path !== '/recover';
  // Keep user login/account links out of the public-facing results pages.
  // They remain available on the private /account and /login screens.
  res.locals.isUserArea = req.path === '/login' || req.path.startsWith('/account') || req.path === '/recover';
  req.session.visitorId = req.session.visitorId || crypto.randomUUID();
  res.locals.visitorId = req.session.visitorId;

  next();
});

app.use('/', publicRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

// Central production error handler. Do not leak database/stack details to users;
// keep the diagnostic in server logs instead so a broken write never becomes a
// blank/generic proxy error with no useful server-side trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled request error:', err && err.stack ? err.stack : err);
  res.status(500).send('Something went wrong while saving that change. Please try again. If it keeps happening, check the server logs.');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Publishes any result an admin scheduled ahead of time (entered during the
// closing window, held back until draw time) the moment its time arrives —
// no admin needs to be online at that exact moment for it to go live.
setInterval(() => {
  db.publishDueScheduledResults().catch((e) => console.error('Scheduled publish check failed:', e));
}, 30 * 1000);

// Automatically move results older than 40 days into the trash (see
// db.cleanupOldResults). Run once on startup, then once a day after that.
const removedOnStartup = db.cleanupOldResults();
if (removedOnStartup > 0) {
  console.log(`Moved ${removedOnStartup} result(s) older than 40 days into the trash.`);
}
setInterval(() => {
  db.cleanupOldResults();
}, 1000 * 60 * 60 * 24); // once a day

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
