const express = require('express');
const router = express.Router();
const db = require('./db');
const { requireLogin } = require('./middleware-auth');
const { slugify, makeId, makeRecoveryCode, hashPassword, verifyPassword, isValidResultText } = require('./utils');
const { authenticator } = require('otplib');

// ---------- LOGIN / LOGOUT ----------

// Simple in-memory lockout after repeated failed password attempts. Keyed by
// IP address. Resets on server restart — that's fine, it's just a brake on
// rapid guessing, not a permanent ban list.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes

function getAttemptState(ip) {
  return loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
}
function parseDrawMinutes(drawTime) {
  if (!drawTime) return null;
  const raw = String(drawTime).trim().toUpperCase().replace(/\s+/g, ' ');
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  let h, min, ap;
  if (m) { h = Number(m[1]); min = Number(m[2]); ap = m[3]; }
  else { m = raw.match(/^(\d{1,2})\s*(AM|PM)$/); if (!m) return null; h = Number(m[1]); min = 0; ap = m[2]; }
  if (min > 59) return null;
  if (ap) { if (h >= 13 && h <= 23) { /* normalize legacy 23:07pm */ } else { if (h < 1 || h > 12) return null; if (h === 12) h = 0; if (ap === 'PM') h += 12; } }
  return h >= 0 && h <= 23 ? h * 60 + min : null;
}
function lotteryEntryStatus(lottery) {
  const dm=parseDrawMinutes(lottery.drawTime); if(dm==null)return {locked:false,cutoff:'—'};
  const tz=process.env.LOTTERY_TIMEZONE||'Asia/Kolkata'; const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()); const h=Number(parts.find(p=>p.type==='hour').value)%24,m=Number(parts.find(p=>p.type==='minute').value),now=h*60+m,cut=(dm-15+1440)%1440; const locked=dm>=15?(now>=cut&&now<=1439):(now>=cut||now<=dm); return {locked,cutoff:String(Math.floor(cut/60)).padStart(2,'0')+':'+String(cut%60).padStart(2,'0')};
}
function normalizeDrawTime(drawTime) {
  if (!String(drawTime || '').trim()) return '';
  const minutes = parseDrawMinutes(drawTime);
  if (minutes == null) return null;
  const h = Math.floor(minutes / 60).toString().padStart(2,'0');
  const m = String(minutes % 60).padStart(2,'0');
  return `${h}:${m}`;
}

router.get('/login', (req, res) => {
  res.render('admin-login', { error: null, flash: req.query.flash || null, otpRequired: !!db.get('settings.adminTotpSecret').value() });
});

router.post('/login', (req, res) => {
  const { password, otp } = req.body;
  const ip = req.ip;
  const state = getAttemptState(ip);

  if (state.lockedUntil > Date.now()) {
    const minutesLeft = Math.ceil((state.lockedUntil - Date.now()) / 60000);
    return res.render('admin-login', { error: `Too many wrong attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`, otpRequired: !!db.get('settings.adminTotpSecret').value() });
  }

  const storedHash = db.get('settings.adminPasswordHash').value();
  const totpSecret = db.get('settings.adminTotpSecret').value() || '';
  // 2FA is optional. When a secret exists, the authenticator code is required.
  // When the secret is empty (2FA disabled), a correct password alone is enough
  // to sign in. Disabling 2FA must never force a new 2FA setup on the next login.
  const otpRequired = !!totpSecret;
  const passwordValid = !!password && !!storedHash && verifyPassword(password, storedHash);
  const otpValid = !!totpSecret && !!otp && authenticator.check(String(otp).replace(/\s+/g,''), totpSecret);

  if (passwordValid && (!totpSecret || otpValid)) {
    loginAttempts.delete(ip);
    return req.session.regenerate((err) => {
      if (err) return res.status(500).send('Unable to start a secure admin session.');
      req.session.isAdmin = true;
      req.session.adminSessionVersion = Number(db.get('settings.adminSessionVersion').value() || 0);
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
      const log = db.get('auditLog').value() || [];
      log.push({ id: makeId(), action: 'Logged in', detail: '', ip, timestamp: new Date().toISOString() });
      db.set('auditLog', log.slice(-200)).write();
      return res.redirect('/admin');
    });
  }

  state.count += 1;
  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
    loginAttempts.set(ip, state);
    return res.render('admin-login', { error: `Too many wrong attempts. Try again in ${LOCKOUT_MS / 60000} minutes.`, otpRequired: !!db.get('settings.adminTotpSecret').value() });
  }
  loginAttempts.set(ip, state);
  res.render('admin-login', {
    otpRequired,
    error: otpRequired ? `Wrong password or authenticator code. Try again. (${MAX_ATTEMPTS - state.count} attempt${MAX_ATTEMPTS - state.count === 1 ? '' : 's'} left before a temporary lockout.)` : `Wrong password. Try again. (${MAX_ATTEMPTS - state.count} attempt${MAX_ATTEMPTS - state.count === 1 ? '' : 's'} left before a temporary lockout.)`,
  });
});

router.get('/2fa/setup', (req, res) => {
  if (!req.session.pendingAdmin2fa || !req.session.pendingAdmin2fa.secret) return res.redirect('/admin/login');
  res.render('admin-2fa-setup', { secret: req.session.pendingAdmin2fa.secret, otpauth: req.session.pendingAdmin2fa.otpauth, error: null });
});

router.post('/2fa/setup', (req, res) => {
  if (!req.session.pendingAdmin2fa || !req.session.pendingAdmin2fa.secret) return res.redirect('/admin/login');
  const code = String(req.body.otp || '').replace(/\s+/g, '');
  if (!authenticator.check(code, req.session.pendingAdmin2fa.secret)) return res.render('admin-2fa-setup', { secret: req.session.pendingAdmin2fa.secret, otpauth: req.session.pendingAdmin2fa.otpauth, error: 'That code is not valid. Check your authenticator and try again.' });
  db.set('settings.adminTotpSecret', req.session.pendingAdmin2fa.secret).write();
  delete req.session.pendingAdmin2fa;
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Unable to start a secure admin session.');
    req.session.isAdmin = true;
    req.session.adminSessionVersion = Number(db.get('settings.adminSessionVersion').value() || 0);
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    logAction({ ip: req.ip }, 'Admin 2FA enabled', 'Authenticator setup completed');
    res.redirect('/admin?flash=' + encodeURIComponent('2FA enabled.'));
  });
});

router.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin/login')); });

// Everything below this line requires login
router.use(requireLogin);

// Read a one-time confirmation message from ?flash=... so every admin page
// below can show a "✓ Saved" style banner after a redirect, without each
// route having to pass it into res.render manually.
router.use((req, res, next) => {
  res.locals.flash = req.query.flash || null;
  next();
});

function redirectWithFlash(res, path, message) {
  const sep = path.includes('?') ? '&' : '?';
  res.redirect(`${path}${sep}flash=${encodeURIComponent(message)}`);
}

// Internal log of admin actions — who changed what, when. Admin-only, never
// shown on the public site. Capped to the most recent 200 entries so the
// data file doesn't grow forever.
const MAX_AUDIT_ENTRIES = 200;
function logAction(req, action, detail) {
  const log = db.get('auditLog').value() || [];
  log.push({
    id: makeId(),
    action,
    detail: detail || '',
    ip: req.ip || '',
    timestamp: new Date().toISOString(),
  });
  db.set('auditLog', log.slice(-MAX_AUDIT_ENTRIES)).write();
}

// ---------- SITE SETTINGS ----------

router.get('/settings', (req, res) => {
  const siteName = db.get('settings.siteName').value() || 'Haryana Results';
  const contactNumber = db.get('settings.contactNumber').value() || '';
  const contactLabel = db.get('settings.contactLabel').value() || 'Help & Queries';
  const contactType = db.get('settings.contactType').value() || 'call';
  res.render('admin-settings', { currentName: siteName, currentContactNumber: contactNumber, currentContactLabel: contactLabel, currentContactType: contactType, error: null, passwordError: null });
});

router.post('/settings/2fa/regenerate', (req, res) => {
  const password=String(req.body.currentPassword||''); const otp=String(req.body.otp||'').replace(/\s+/g,''); const hash=db.get('settings.adminPasswordHash').value(); const secret=db.get('settings.adminTotpSecret').value()||'';
  if(!verifyPassword(password,hash)||!secret||!authenticator.check(otp,secret)) return res.status(403).send('Password or current authenticator code is incorrect.');
  const next=authenticator.generateSecret(); db.set('settings.adminTotpSecret',next).write(); db.set('settings.adminSessionVersion',Number(db.get('settings.adminSessionVersion').value()||0)+1).write(); logAction(req,'Admin 2FA regenerated','All admin sessions invalidated.'); req.session.destroy(()=>res.redirect('/admin/login?flash='+encodeURIComponent('2FA was regenerated. Set up the new secret before logging in.')));
});

router.post('/settings/2fa/disable', (req, res) => {
  const password = String(req.body.currentPassword || '');
  const otp = String(req.body.otp || '').replace(/\s+/g, '');
  const hash = db.get('settings.adminPasswordHash').value();
  const secret = db.get('settings.adminTotpSecret').value() || '';

  if (!secret || !verifyPassword(password, hash) || !authenticator.check(otp, secret)) {
    return res.status(403).send('Password or current authenticator code is incorrect.');
  }

  db.set('settings.adminTotpSecret', '').write();
  db.set('settings.adminSessionVersion', Number(db.get('settings.adminSessionVersion').value() || 0) + 1).write();
  logAction(req, 'Admin 2FA disabled', '2FA was disabled after password and current authenticator verification.');
  req.session.destroy(() => res.redirect('/admin/login?flash=' + encodeURIComponent('Admin 2FA was disabled. Enable it again before public launch.')));
});

router.post('/settings/2fa/enable', (req, res) => {
  const password = String(req.body.currentPassword || '');
  const hash = db.get('settings.adminPasswordHash').value();
  if (!hash || !verifyPassword(password, hash)) {
    return res.status(403).send('Current admin password is incorrect.');
  }
  if (db.get('settings.adminTotpSecret').value()) return res.redirect('/admin/settings/2fa');

  const secret = authenticator.generateSecret();
  req.session.pendingAdmin2fa = {
    secret,
    otpauth: authenticator.keyuri('admin', process.env.ADMIN_2FA_ISSUER || 'Lottery Results', secret),
  };
  return res.redirect('/admin/2fa/setup');
});

router.get('/settings/2fa', (req, res) => {
  const secret = db.get('settings.adminTotpSecret').value() || '';
  res.render('admin-2fa-status', { enabled: !!secret });
});

router.post('/settings', (req, res) => {
  const { contactNumber, contactLabel, contactType } = req.body;
  // Contact number/label are optional — leaving them blank hides the contact bar on the site
  db.set('settings.contactNumber', (contactNumber || '').trim()).write();
  db.set('settings.contactLabel', (contactLabel || '').trim() || 'Help & Queries').write();
  db.set('settings.contactType', contactType === 'whatsapp' ? 'whatsapp' : 'call').write();
  logAction(req, 'Settings updated', 'Contact details updated');
  redirectWithFlash(res, '/admin', 'Settings saved');
});

// ---------- EDIT PAGES (site name + Disclaimer / Privacy / About content) ----------

router.get('/pages', (req, res) => {
  res.render('admin-pages', {
    currentName: db.get('settings.siteName').value() || 'Haryana Results',
    disclaimerText: db.get('settings.disclaimerText').value() || '',
    privacyText: db.get('settings.privacyText').value() || '',
    aboutText: db.get('settings.aboutText').value() || '',
    error: null,
  });
});

router.post('/pages', (req, res) => {
  const { siteName, disclaimerText, privacyText, aboutText } = req.body;
  if (!siteName || !siteName.trim()) {
    return res.render('admin-pages', {
      currentName: db.get('settings.siteName').value() || 'Haryana Results',
      disclaimerText: disclaimerText || '',
      privacyText: privacyText || '',
      aboutText: aboutText || '',
      error: 'Please enter a website name.',
    });
  }
  db.set('settings.siteName', siteName.trim()).write();
  db.set('settings.disclaimerText', (disclaimerText || '').trim()).write();
  db.set('settings.privacyText', (privacyText || '').trim()).write();
  db.set('settings.aboutText', (aboutText || '').trim()).write();
  logAction(req, 'Pages updated', `Site name: ${siteName.trim()}`);
  redirectWithFlash(res, '/admin/pages', 'Pages saved');
});

// ---------- BACKUP EXPORT ----------

router.get('/settings/backup', async (req, res) => {
  try {
    const payload = await db.encryptedBackup();
    const dateStamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="lottery-backup-${dateStamp}.enc.json"`);
    res.send(payload);
  } catch (e) { res.status(503).send('Backup unavailable. Configure BACKUP_ENCRYPTION_KEY first.'); }
});

// ---------- CHANGE ADMIN PASSWORD ----------

router.post('/settings/password', (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const siteName = db.get('settings.siteName').value() || 'Haryana Results';
  const contactNumber = db.get('settings.contactNumber').value() || '';
  const contactLabel = db.get('settings.contactLabel').value() || 'Help & Queries';
  const contactType = db.get('settings.contactType').value() || 'call';

  const renderWithError = (passwordError) =>
    res.render('admin-settings', {
      currentName: siteName,
      currentContactNumber: contactNumber,
      currentContactLabel: contactLabel,
      currentContactType: contactType,
      error: null,
      passwordError,
    });

  const storedHash = db.get('settings.adminPasswordHash').value();
  if (!currentPassword || !verifyPassword(currentPassword, storedHash)) {
    return renderWithError('Current password is incorrect.');
  }
  if (!newPassword || newPassword.length < 8) {
    return renderWithError('New password must be at least 8 characters.');
  }
  if (newPassword !== confirmPassword) {
    return renderWithError('New password and confirmation do not match.');
  }

  db.set('settings.adminPasswordHash', hashPassword(newPassword)).write();
  db.set('settings.adminSessionVersion', Number(db.get('settings.adminSessionVersion').value() || 0) + 1).write();
  logAction(req, 'Password changed', '');
  // Log out all sessions (including this one) so everyone has to log back
  // in with the new password.
  req.session.destroy(() => res.redirect('/admin/login?flash=' + encodeURIComponent('Password changed. Please log in.')));
});

// ---------- DASHBOARD ----------

function getLotteriesWithLatest() {
  const lotteries = db.get('lotteries').value() || [];
  const allPurchases = db.get('purchases').value() || [];
  return lotteries.map((lottery) => {
    const results = db
      .get('results')
      .filter((r) => r.lotteryId === lottery.id && !r.deletedAt)
      .sortBy('date')
      .reverse()
      .value();
    const purchaseTotals = allPurchases
      .filter((p) => p.lotteryId === lottery.id)
      .reduce(
        (acc, p) => ({ tickets: acc.tickets + p.tickets, amount: acc.amount + p.amount }),
        { tickets: 0, amount: 0 }
      );
    return { ...lottery, latestResult: results[0] || null, purchaseTotals, entryStatus: lotteryEntryStatus(lottery) };
  });
}

// A single "Settings" hub linking to the pages that used to sit as
// separate buttons directly on the dashboard (Website Settings, Edit
// Pages, Site Stats, Audit Log) — keeps the dashboard itself uncluttered.
router.get('/hub', (req, res) => {
  res.render('admin-hub', {});
});

router.get('/', async (req, res) => {
  const dbHealth=await db.healthCheck();
  const lotteries=getLotteriesWithLatest(); const purchases=db.get('purchases').value()||[]; const users=db.get('users').value()||[]; const totalTickets=purchases.reduce((s,p)=>s+(Number(p.tickets)||0),0); const totalAmount=purchases.reduce((s,p)=>s+(Number(p.amount)||0),0);
  res.render('admin-dashboard', { lotteries, error: null, quickSummary:{users:users.length,totalTickets,totalAmount,lotteries:lotteries.length,database:dbHealth.ok} });
});

// ---------- SITE-WIDE STATS ----------

router.get('/stats', async (req, res) => {
  const lotteries = db.get('lotteries').value() || [];
  const results = db.get('results').value() || [];
  const purchases = db.get('purchases').value() || [];
  const totalTickets = purchases.reduce((sum,p)=>sum+(Number(p.tickets)||0),0);
  const totalAmount = purchases.reduce((sum,p)=>sum+(Number(p.amount)||0),0);
  const uniqueBuyers = new Set(purchases.map(p=>p.userId ? `user:${p.userId}` : `name:${String(p.buyerName||'').trim().toLowerCase()}`)).size;
  const perLottery = lotteries.map(lottery=>{const entries=purchases.filter(p=>p.lotteryId===lottery.id);return{name:lottery.name,tickets:entries.reduce((s,p)=>s+(Number(p.tickets)||0),0),amount:entries.reduce((s,p)=>s+(Number(p.amount)||0),0)}});
  const busiestLottery=perLottery.reduce((best,l)=>l.tickets>(best?best.tickets:0)?l:best,null);
  const tz=process.env.LOTTERY_TIMEZONE||'Asia/Kolkata'; const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()); const today=`${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
  let rows=await db.getVisitStats(14); if(!rows){const analytics=db.get('analytics').value()||{};rows=Object.entries(analytics).map(([date,visits])=>({date,visits,uniqueSessions:0}));}
  const map=new Map(rows.map(r=>[r.date,r])); const last14Days=[]; for(let i=0;i<14;i++){const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-i);const ds=d.toISOString().slice(0,10);last14Days.push({date:ds,visits:map.get(ds)?.visits||0,uniqueSessions:map.get(ds)?.uniqueSessions||0});}
  res.render('admin-stats',{totalLotteries:lotteries.length,totalResults:results.filter(r=>!r.deletedAt).length,totalTickets,totalAmount,uniqueBuyers,busiestLottery,perLottery:perLottery.sort((a,b)=>b.tickets-a.tickets),todaysVisits:(map.get(today)?.visits||0),todaysUnique:(map.get(today)?.uniqueSessions||0),last14Days});
});

// ---------- ADD NEW LOTTERY ----------

router.get('/lottery/new', (req, res) => {
  res.render('admin-add-lottery', { error: null });
});

router.post('/lottery/new', (req, res) => {
  const { name, drawTime } = req.body;
  if (!name || !name.trim()) {
    return res.render('admin-add-lottery', { error: 'Please enter a lottery name.' });
  }
  const normalizedDrawTime = normalizeDrawTime(drawTime);
  if (normalizedDrawTime === null) return res.render('admin-add-lottery', { error: 'Please enter a valid draw time, such as 08:00, 8:00 AM, or 23:07.' });

  const slug = slugify(name);
  const existing = db.get('lotteries').find({ slug }).value();
  if (existing) {
    return res.render('admin-add-lottery', {
      error: 'A lottery with a very similar name already exists.',
    });
  }

  db.get('lotteries')
    .push({
      id: makeId(),
      name: name.trim(),
      slug,
      drawTime: normalizedDrawTime,
      starred: false,
      createdAt: new Date().toISOString(),
    })
    .write();

  logAction(req, 'Lottery added', name.trim());
  redirectWithFlash(res, '/admin', 'Lottery added');
});

// ---------- EDIT LOTTERY (name, draw time) ----------

router.get('/lottery/:id/edit', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');
  res.render('admin-edit-lottery', { lottery, error: null });
});

router.post('/lottery/:id/edit', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const { name, drawTime } = req.body;

  if (!name || !name.trim()) {
    return res.render('admin-edit-lottery', { lottery, error: 'Please enter a lottery name.' });
  }
  const normalizedDrawTime = normalizeDrawTime(drawTime);
  if (normalizedDrawTime === null) return res.render('admin-edit-lottery', { lottery, error: 'Please enter a valid draw time, such as 08:00, 8:00 AM, or 23:07.' });

  db.get('lotteries')
    .find({ id: lottery.id })
    .assign({ name: name.trim(), drawTime: normalizedDrawTime })
    .write();

  logAction(req, 'Lottery updated', `${lottery.name} → ${name.trim()}`);
  redirectWithFlash(res, '/admin', 'Lottery updated');
});

// ---------- STAR / UNSTAR A LOTTERY (only one at a time) ----------

router.post('/lottery/:id/star', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  if (lottery.starred) {
    // Already starred — clicking again removes the star
    db.get('lotteries').find({ id: lottery.id }).assign({ starred: false }).write();
    logAction(req, 'Unstarred lottery', lottery.name);
  } else {
    // Unstar every other lottery first, then star this one
    db.get('lotteries').value().forEach((l) => {
      db.get('lotteries').find({ id: l.id }).assign({ starred: false }).write();
    });
    db.get('lotteries').find({ id: lottery.id }).assign({ starred: true }).write();
    logAction(req, 'Starred lottery', lottery.name);
  }

  res.redirect('/admin');
});

// ---------- MARK / UNMARK AS ONE OF THE 4 HOMEPAGE "MAIN" LOTTERIES ----------

router.post('/lottery/:id/main', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  if (lottery.isMain) {
    db.get('lotteries').find({ id: lottery.id }).assign({ isMain: false }).write();
    logAction(req, 'Removed from Main', lottery.name);
  } else {
    const currentMainCount = db.get('lotteries').filter({ isMain: true }).value().length;
    if (currentMainCount >= 4) {
      return res.render('admin-dashboard', {
        lotteries: getLotteriesWithLatest(),
        error: 'Only 4 lotteries can be featured in the main homepage grid at once. Un-mark one first.',
      });
    }
    db.get('lotteries').find({ id: lottery.id }).assign({ isMain: true }).write();
    logAction(req, 'Added to Main', lottery.name);
  }

  res.redirect('/admin');
});

// Delete a lottery (and its results)
router.post('/lottery/:id/delete', (req, res) => {
  const { id } = req.params;
  const lottery = db.get('lotteries').find({ id }).value();
  db.get('lotteries').remove({ id }).write();
  db.get('results').remove({ lotteryId: id }).write();
  db.get('purchases').remove({ lotteryId: id }).write();
  db.get('watchedNumbers').remove({ lotteryId: id }).write();
  db.get('notifications').remove({ lotteryId: id }).write();
  logAction(req, 'Lottery deleted', lottery ? lottery.name : id);
  redirectWithFlash(res, '/admin', 'Lottery deleted');
});

// ---------- ADD / UPDATE RESULT ----------

function activeResultsFor(lotteryId) {
  return db
    .get('results')
    .filter((r) => r.lotteryId === lotteryId && !r.deletedAt)
    .sortBy('date')
    .reverse()
    .value();
}

function trashedResultsFor(lotteryId) {
  return db
    .get('results')
    .filter((r) => r.lotteryId === lotteryId && !!r.deletedAt)
    .sortBy('deletedAt')
    .reverse()
    .value();
}

router.get('/lottery/:id/result', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const tz = process.env.LOTTERY_TIMEZONE || 'Asia/Kolkata';
  const nowParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const todayStr = `${nowParts.find((p) => p.type === 'year').value}-${nowParts.find((p) => p.type === 'month').value}-${nowParts.find((p) => p.type === 'day').value}`;

  res.render('admin-update-result', {
    lottery,
    results: activeResultsFor(lottery.id),
    trashedResults: trashedResultsFor(lottery.id),
    error: null,
    todayStr,
  });
});

// Combines a date (YYYY-MM-DD) and a draw time string (e.g. "8:00 AM") into
// the correct UTC instant for that moment in LOTTERY_TIMEZONE. Since the
// server requires LOTTERY_TIMEZONE=Asia/Kolkata (no daylight saving), a
// simple fixed-offset correction is accurate here.
function computeScheduledIso(dateStr, drawTime, timeZone) {
  if (!drawTime) return null;
  const raw = String(drawTime).trim().toUpperCase().replace(/\s+/g, ' ');
  let h, min;
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (m) {
    h = Number(m[1]); min = Number(m[2]);
    if (m[3] === 'PM' && h !== 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
  } else {
    m = raw.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (!m) return null;
    h = Number(m[1]); min = 0;
    if (m[2] === 'PM' && h !== 12) h += 12;
    if (m[2] === 'AM' && h === 12) h = 0;
  }
  if (h == null || h < 0 || h > 23 || min < 0 || min > 59) return null;

  const guess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const shownMinutesTotal = (get('hour') % 24) * 60 + get('minute');
  const targetMinutesTotal = h * 60 + min;
  const diffMinutes = targetMinutesTotal - shownMinutesTotal;
  return new Date(guess.getTime() + diffMinutes * 60000).toISOString();
}

router.post('/lottery/:id/result', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const { date, resultText, publishMode } = req.body;
  const dateStr=String(date||''); const parsedDate=new Date(`${dateStr}T00:00:00Z`); const dateOk=/^\d{4}-\d{2}-\d{2}$/.test(dateStr)&&!Number.isNaN(parsedDate.getTime())&&parsedDate.toISOString().slice(0,10)===dateStr;
  if (!dateOk || !resultText || !resultText.trim()) {
    return res.render('admin-update-result', {
      lottery,
      results: activeResultsFor(lottery.id),
      trashedResults: trashedResultsFor(lottery.id),
      error: 'Please fill in both the date and the result.',
    });
  }

  const tz=process.env.LOTTERY_TIMEZONE||'Asia/Kolkata'; const nowParts=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()); const todayStr=`${nowParts.find(p=>p.type==='year').value}-${nowParts.find(p=>p.type==='month').value}-${nowParts.find(p=>p.type==='day').value}`;
  if (dateStr > todayStr) return res.render('admin-update-result',{lottery,results:activeResultsFor(lottery.id),trashedResults:trashedResultsFor(lottery.id),error:'A result date cannot be in the future.'});

  if (!isValidResultText(resultText)) {
    return res.render('admin-update-result', {
      lottery,
      results: activeResultsFor(lottery.id),
      trashedResults: trashedResultsFor(lottery.id),
      error: 'Result should only contain numbers (spaces, commas or dashes are fine for more than one number) — please check for typos.',
    });
  }

  // Optional scheduling: during the lottery's closing window, an admin can
  // enter today's result early and hold it back until the official draw
  // time instead of publishing it the instant it's saved.
  let scheduledFor = null;
  let published = true;
  if (publishMode === 'schedule' && date === todayStr) {
    const iso = computeScheduledIso(date, lottery.drawTime, tz);
    if (iso && new Date(iso).getTime() > Date.now()) {
      scheduledFor = iso;
      published = false;
    }
  }

  // If an active result for this date already exists, update it instead of duplicating
  const existing = db.get('results').find((r) => r.lotteryId === lottery.id && r.date === date && !r.deletedAt).value();
  let savedResult;
  if (existing) {
    db.get('results')
      .find({ id: existing.id })
      .assign({ resultText: resultText.trim(), updatedAt: new Date().toISOString(), scheduledFor, published })
      .write();
    savedResult = { ...existing, resultText: resultText.trim(), date, scheduledFor, published };
  } else {
    savedResult = {
      id: makeId(),
      lotteryId: lottery.id,
      date,
      resultText: resultText.trim(),
      updatedAt: new Date().toISOString(),
      scheduledFor,
      published,
    };
    db.get('results').push(savedResult).write();
  }

  // Notify followers immediately only if this result is actually public now.
  // A scheduled result gets its notifications later, at publish time,
  // via the same helper (see db.publishDueScheduledResults in server.js).
  if (published) db.notifyResultWatchers(lottery, savedResult);

  logAction(req, 'Result saved', `${lottery.name} — ${date}: ${resultText.trim()}${scheduledFor ? ` (scheduled for ${scheduledFor})` : ''}`);
  redirectWithFlash(res, `/admin/lottery/${lottery.id}/result`, scheduledFor ? 'Result saved — will go live automatically at draw time' : 'Result saved');
});

// Soft-delete: mark as deleted but keep it in the trash so it can be undone
router.post('/lottery/:id/result/:resultId/delete', (req, res) => {
  const result = db.get('results').find({ id: req.params.resultId }).value();
  db.get('results')
    .find({ id: req.params.resultId })
    .assign({ deletedAt: new Date().toISOString() })
    .write();
  logAction(req, 'Result deleted', result ? `${result.date}: ${result.resultText}` : req.params.resultId);
  redirectWithFlash(res, `/admin/lottery/${req.params.id}/result`, 'Result deleted (restore it below if that was a mistake)');
});

// Restore a soft-deleted result
router.post('/lottery/:id/result/:resultId/restore', (req, res) => {
  const result = db.get('results').find({ id: req.params.resultId }).value();
  db.get('results')
    .find({ id: req.params.resultId })
    .assign({ deletedAt: null })
    .write();
  logAction(req, 'Result restored', result ? `${result.date}: ${result.resultText}` : req.params.resultId);
  redirectWithFlash(res, `/admin/lottery/${req.params.id}/result`, 'Result restored');
});

// Permanently remove a soft-deleted result from the trash
router.post('/lottery/:id/result/:resultId/purge', (req, res) => {
  const result = db.get('results').find({ id: req.params.resultId }).value();
  db.get('results').remove({ id: req.params.resultId }).write();
  logAction(req, 'Result permanently deleted', result ? `${result.date}: ${result.resultText}` : req.params.resultId);
  redirectWithFlash(res, `/admin/lottery/${req.params.id}/result`, 'Permanently deleted');
});

// ---------- TICKET PURCHASE TRACKING (admin-only bookkeeping) ----------
// Internal record of who bought tickets for which number (00-99) on a given
// lottery. This is purely for the admin's own records — it is never shown
// on the public site and has no effect on which result gets posted.

function allNumbers() {
  const nums = [];
  for (let i = 0; i < 100; i++) nums.push(String(i).padStart(2, '0'));
  return nums;
}

router.get('/lottery/:id/purchases', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const entries = db.get('purchases').filter({ lotteryId: lottery.id }).value();
  const follows = db.get('watchedNumbers').filter({ lotteryId: lottery.id }).value();
  const totals = {};
  allNumbers().forEach((n) => { totals[n] = { tickets: 0, amount: 0, followers: 0 }; });
  entries.forEach((e) => {
    totals[e.number].tickets += e.tickets;
    totals[e.number].amount += e.amount;
  });
  follows.forEach((f) => { totals[f.number].followers += 1; });

  res.render('admin-purchases-grid', { lottery, numbers: allNumbers(), totals });
});

// CSV export of every purchase entry for a lottery, for the admin's own records
function csvField(value) {
  const str = String(value === undefined || value === null ? '' : value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get('/lottery/:id/purchases/export.csv', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const entries = db
    .get('purchases')
    .filter({ lotteryId: lottery.id })
    .sortBy(['number', 'createdAt'])
    .value();

  const lines = ['Number,Buyer Name,Tickets,Amount,Logged At'];
  entries.forEach((e) => {
    lines.push(
      [csvField(e.number), csvField(e.buyerName), csvField(e.tickets), csvField(e.amount), csvField(e.createdAt)].join(',')
    );
  });

  const dateStamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${lottery.slug}-purchases-${dateStamp}.csv"`);
  res.send(lines.join('\n'));
});

router.get('/lottery/:id/purchases/:number', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');
  const { number } = req.params;
  if (!/^\d{2}$/.test(number)) return res.status(404).send('Invalid number');

  const search=String(req.query.q||'').trim().toLowerCase();
  const entries = db
    .get('purchases')
    .filter({ lotteryId: lottery.id, number })
    .sortBy('createdAt')
    .reverse()
    .value()
    .filter(e=>!search||String(e.buyerName||'').toLowerCase().includes(search)||String(e.userId||'').toLowerCase().includes(search));
  const followers = db.get('watchedNumbers').filter({ lotteryId: lottery.id, number }).value().map(w => {
    const user = db.get('users').find({ id: w.userId }).value();
    return { ...w, userName: user ? user.name : 'Unknown user', userCode: user ? user.userCode : '' };
  });

  res.render('admin-purchases-number', { lottery, number, entries, followers, users: db.get('users').value() || [], error: null });
});

router.post('/lottery/:id/purchases/:number', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');
  const { number } = req.params;
  if (!/^\d{2}$/.test(number)) return res.status(404).send('Invalid number');

  const { buyerName, userId, tickets, amount } = req.body;
  const linkedUser = userId ? db.get('users').find({ id: userId }).value() : null;
  const effectiveBuyerName = linkedUser ? linkedUser.name : String(buyerName || '').trim();
  const ticketsNum = parseInt(tickets, 10);
  const amountNum = parseFloat(amount);

  if (!effectiveBuyerName || !Number.isInteger(ticketsNum) || ticketsNum < 1 || ticketsNum > 100000 || !Number.isFinite(amountNum) || amountNum < 0 || amountNum > 10000000) {
    const entries = db
      .get('purchases')
      .filter({ lotteryId: lottery.id, number })
      .sortBy('createdAt')
      .reverse()
      .value();
    const followers = db.get('watchedNumbers').filter({ lotteryId: lottery.id, number }).value().map(w => {
      const user = db.get('users').find({ id: w.userId }).value();
      return { ...w, userName: user ? user.name : 'Unknown user', userCode: user ? user.userCode : '' };
    });
    return res.render('admin-purchases-number', {
      lottery,
      number,
      entries,
      followers,
      users: db.get('users').value() || [],
      error: 'Please choose a user or enter a buyer name, enter at least 1 ticket, and enter a valid amount.',
    });
  }

  db.get('purchases')
    .push({
      id: makeId(),
      lotteryId: lottery.id,
      number,
      userId: linkedUser ? linkedUser.id : null,
      buyerName: effectiveBuyerName,
      tickets: ticketsNum,
      amount: amountNum,
      createdAt: new Date().toISOString(),
    })
    .write();

  logAction(req, 'Purchase entry added', `${lottery.name} No.${number} — ${effectiveBuyerName} (${ticketsNum} tkt)`);
  redirectWithFlash(res, `/admin/lottery/${lottery.id}/purchases/${number}`, 'Entry added');
});

// ---------- EDIT A SINGLE TICKET PURCHASE ENTRY ----------

router.get('/lottery/:id/purchases/:number/:entryId/edit', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');
  const { number, entryId } = req.params;
  const entry = db.get('purchases').find({ id: entryId, lotteryId: lottery.id }).value();
  if (!entry) return res.status(404).send('Entry not found');

  res.render('admin-purchases-edit-entry', { lottery, number, entry, users: db.get('users').value() || [], error: null });
});

router.post('/lottery/:id/purchases/:number/:entryId/edit', (req, res) => {
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');
  const { number, entryId } = req.params;
  const entry = db.get('purchases').find({ id: entryId, lotteryId: lottery.id }).value();
  if (!entry) return res.status(404).send('Entry not found');

  const { buyerName, userId, tickets, amount } = req.body;
  const linkedUser = userId ? db.get('users').find({ id: userId }).value() : null;
  const effectiveBuyerName = linkedUser ? linkedUser.name : String(buyerName || '').trim();
  const ticketsNum = parseInt(tickets, 10);
  const amountNum = parseFloat(amount);

  if (!effectiveBuyerName || !Number.isInteger(ticketsNum) || ticketsNum < 1 || ticketsNum > 100000 || !Number.isFinite(amountNum) || amountNum < 0 || amountNum > 10000000) {
    return res.render('admin-purchases-edit-entry', {
      lottery,
      number,
      entry,
      users: db.get('users').value() || [],
      error: 'Please choose a user or enter a buyer name, enter at least 1 ticket, and enter a valid amount.',
    });
  }

  db.get('purchases')
    .find({ id: entryId })
    .assign({
      userId: linkedUser ? linkedUser.id : null,
      buyerName: effectiveBuyerName,
      tickets: ticketsNum,
      amount: amountNum,
    })
    .write();

  logAction(req, 'Purchase entry updated', `${lottery.name} No.${number} — ${effectiveBuyerName}`);
  redirectWithFlash(res, `/admin/lottery/${lottery.id}/purchases/${number}`, 'Entry updated');
});

router.post('/lottery/:id/purchases/:number/:entryId/delete', (req, res) => {
  const entry = db.get('purchases').find({ id: req.params.entryId }).value();
  db.get('purchases').remove({ id: req.params.entryId }).write();
  logAction(req, 'Purchase entry deleted', entry ? `No.${entry.number} — ${entry.buyerName}` : req.params.entryId);
  redirectWithFlash(res, `/admin/lottery/${req.params.id}/purchases/${req.params.number}`, 'Entry deleted');
});

// ---------- AUDIT LOG ----------

router.get('/audit-log', (req, res) => {
  const log = (db.get('auditLog').value() || []).slice().reverse();
  res.render('admin-audit-log', { log });
});


// ---------- USER ACCOUNTS (result-notification accounts) ----------
router.get('/users', (req, res) => {
  res.render('admin-users', { error: null });
});

// Existing users are kept on a separate page so the account-creation screen
// stays clean. This does not change the existing followed-number system.
router.get('/users/existing', (req, res) => {
  const search=String(req.query.q||'').trim().toLowerCase();
  const users = (db.get('users').value() || []).filter(u=>!search||String(u.name||'').toLowerCase().includes(search)||String(u.userCode||'').toLowerCase().includes(search));
  const purchases = db.get('purchases').value() || [];
  const lotteries = db.get('lotteries').value() || [];
  const enrichedUsers = users.map((user) => {
    const sameNameUsers = users.filter(u => String(u.name || '').trim().toLowerCase() === String(user.name || '').trim().toLowerCase());
    const userPurchases = purchases.filter((p) => p.userId === user.id || (!p.userId && sameNameUsers.length === 1 && String(p.buyerName || '').trim().toLowerCase() === String(user.name || '').trim().toLowerCase()));
    const purchasedByLottery = {};
    userPurchases.forEach((p) => {
      if (!purchasedByLottery[p.lotteryId]) purchasedByLottery[p.lotteryId] = [];
      purchasedByLottery[p.lotteryId].push(p);
    });
    const purchased = userPurchases.map((p) => {
      const lottery = lotteries.find((l) => l.id === p.lotteryId);
      return { number: p.number, lotteryName: lottery ? lottery.name : 'Unknown lottery', tickets: Number(p.tickets) || 0, amount: Number(p.amount) || 0 };
    });
    return {
      ...user,
      purchasedCount: new Set(userPurchases.map((p) => `${p.lotteryId}:${p.number}`)).size,
      totalTickets: userPurchases.reduce((sum, p) => sum + (Number(p.tickets) || 0), 0),
      totalAmount: userPurchases.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      purchased,
      purchasedByLottery,
    };
  });
  const notice=req.session.recoveryCodeNotice; if(notice){const target=enrichedUsers.find(u=>u.id===notice.userId);if(target)target.recoveryCodeNotice=notice.code;delete req.session.recoveryCodeNotice;}
  res.render('admin-existing-users', { users: enrichedUsers, error: null, q: req.query.q || '' });
});

router.post('/users', (req, res) => {
  const name = (req.body.name || '').trim();
  const userCode = (req.body.userCode || '').trim();
  const password = req.body.password || '';
  const users = db.get('users').value() || [];
  if (!name || !userCode || password.length < 8) {
    return res.render('admin-users', { error: 'Name, personal ID and a password of at least 8 characters are required.' });
  }
  if (users.some(u => u.userCode.toLowerCase() === userCode.toLowerCase())) {
    return res.render('admin-users', { error: 'That personal ID is already in use.' });
  }
  const recoveryCode = makeRecoveryCode();
  db.get('users').push({ id: makeId(), name, userCode, passwordHash: hashPassword(password), recoveryCodeHash: hashPassword(recoveryCode), active: true, sessionVersion: 0, createdAt: new Date().toISOString() }).write();
  logAction(req, 'User account created', `${name} (${userCode})`);
  res.render('admin-users', { error: null, flash: `User account created. Recovery code: ${recoveryCode} — give this code to the user and store it safely.`, recoveryCode });
});

router.post('/users/:id/toggle', (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return res.redirect('/admin/users');
  db.get('users').find({ id: user.id }).assign({ active: !user.active, sessionVersion: Number(user.sessionVersion || 0) + 1 }).write();
  logAction(req, user.active ? 'User disabled' : 'User enabled', `${user.name} (${user.userCode})`);
  redirectWithFlash(res, '/admin/users/existing', 'User status updated');
});

// View one user's purchased lottery numbers and ticket totals.
router.get('/users/:id', (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return res.status(404).send('User account not found');

  const lotteries = db.get('lotteries').value() || [];
  const purchases = db.get('purchases').value() || [];
  const users = db.get('users').value() || [];
  const sameNameUsers = users.filter(u => String(u.name || '').trim().toLowerCase() === String(user.name || '').trim().toLowerCase());
    const userPurchases = purchases.filter((p) => p.userId === user.id || (!p.userId && sameNameUsers.length === 1 && String(p.buyerName || '').trim().toLowerCase() === String(user.name || '').trim().toLowerCase()));

  const lotteryViews = lotteries.map((lottery) => {
    const byNumber = {};
    allNumbers().forEach((n) => { byNumber[n] = { tickets: 0, amount: 0 }; });
    userPurchases.filter((p) => p.lotteryId === lottery.id).forEach((p) => {
      const n = String(p.number).padStart(2, '0');
      if (!byNumber[n]) byNumber[n] = { tickets: 0, amount: 0 };
      byNumber[n].tickets += Number(p.tickets) || 0;
      byNumber[n].amount += Number(p.amount) || 0;
    });
    return { ...lottery, numbers: allNumbers(), byNumber };
  });

  const totalTickets = userPurchases.reduce((sum, p) => sum + (Number(p.tickets) || 0), 0);
  const totalAmount = userPurchases.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const purchasedCount = new Set(userPurchases.map((p) => `${p.lotteryId}:${p.number}`)).size;

  res.render('admin-user-detail', { user, lotteryViews, totalTickets, totalAmount, purchasedCount });
});

router.post('/users/:id/recovery-code', (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return redirectWithFlash(res, '/admin/users/existing', 'User account not found');
  const code = makeRecoveryCode();
  db.get('users').find({ id: user.id }).assign({ recoveryCodeHash: hashPassword(code) }).write();
  logAction(req, 'User recovery code regenerated', `${user.name} (${user.userCode})`);
  req.session.recoveryCodeNotice = { userId:user.id, code };
  redirectWithFlash(res, '/admin/users/existing', `Recovery code generated for ${user.name}. It will be shown once on the next page.`);
});

router.post('/users/:id/password', (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return redirectWithFlash(res, '/admin/users/existing', 'User account not found');
  const password = req.body.password || '';
  if (password.length < 8) return redirectWithFlash(res, '/admin/users/existing', 'Password must be at least 8 characters');
  db.get('users').find({ id: user.id }).assign({ passwordHash: hashPassword(password), sessionVersion: Number(user.sessionVersion || 0) + 1 }).write();
  logAction(req, 'User password reset', `${user.name} (${user.userCode})`);
  redirectWithFlash(res, '/admin/users/existing', `Password reset for ${user.name}`);
});

module.exports = router;
