const express = require('express');
const router = express.Router();
const db = require('./db');
const { verifyPassword, makeId, makeRecoveryCode, hashPassword } = require('./utils');
const crypto = require('crypto');

const userLoginAttempts = new Map();
const USER_MAX_ATTEMPTS = 5;
const USER_LOCKOUT_MS = 10 * 60 * 1000;
function userAttemptState(key) { return userLoginAttempts.get(key) || { count: 0, lockedUntil: 0 }; }

function requireUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.get('users').find({ id: req.session.userId }).value();
    if (user && user.active && Number(user.sessionVersion || 0) === Number(req.session.userSessionVersion || 0)) return next();
    delete req.session.userId;
  }
  return res.redirect('/login');
}

function currentUser(req) {
  return db.get('users').find({ id: req.session.userId }).value();
}


function parseDrawMinutes(drawTime) {
  if (!drawTime) return null;
  const raw = String(drawTime).trim().toUpperCase().replace(/\s+/g, ' ');
  // Accept normal forms such as 23:07, 23:07 PM, 8:00 AM, and 8 AM.
  // Some older lottery records used an invalid hybrid such as "23:07pm".
  // When the hour is already 13-23, treat it as 24-hour time and ignore AM/PM.
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  let h, min, ap;
  if (m) {
    h = Number(m[1]); min = Number(m[2]); ap = m[3];
  } else {
    m = raw.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (!m) return null;
    h = Number(m[1]); min = 0; ap = m[2];
  }
  if (min < 0 || min > 59) return null;
  if (ap) {
    if (h >= 13 && h <= 23) {
      // Invalid-but-common stored value like 23:07pm: keep 23:07.
    } else {
      if (h < 1 || h > 12) return null;
      if (h === 12) h = 0;
      if (ap === 'PM') h += 12;
    }
  }
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

function zonedClock(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

function ticketEntryStatus(lottery) {
  const drawMinutes = parseDrawMinutes(lottery && lottery.drawTime);
  if (drawMinutes == null) return { locked: false, message: '' };
  const tz = process.env.LOTTERY_TIMEZONE || 'Asia/Kolkata';
  const now = zonedClock(tz);
  const nowMinutes = now.hour * 60 + now.minute;
  const cutoff = (drawMinutes - 15 + 1440) % 1440;

  // A lottery's draw is a daily occurrence. This handles the normal case and
  // also correctly handles draws just after midnight (00:00-00:14).
  let locked;
  if (drawMinutes >= 15) {
    locked = nowMinutes >= cutoff && nowMinutes <= 1439;
  } else {
    locked = nowMinutes >= cutoff || nowMinutes <= drawMinutes;
  }

  const hh = Math.floor(cutoff / 60).toString().padStart(2, '0');
  const mm = (cutoff % 60).toString().padStart(2, '0');
  let minutesToCutoff = cutoff - nowMinutes; if (minutesToCutoff < 0) minutesToCutoff += 1440;
  return {
    locked,
    cutoffText: `${hh}:${mm}`,
    drawTime: lottery.drawTime,
    timezone: tz,
    minutesToCutoff: locked ? 0 : minutesToCutoff,
    secondsToCutoff: locked ? 0 : minutesToCutoff * 60,
    message: `Ticket entry is closed for this lottery. Entries stop 15 minutes before the ${lottery.drawTime} result time.`
  };
}
function ensureUserData() {
  if (!db.get('users').value()) db.set('users', []).write();
  if (!db.get('watchedNumbers').value()) db.set('watchedNumbers', []).write();
  if (!db.get('notifications').value()) db.set('notifications', []).write();
}
ensureUserData();

router.get('/recover', (req, res) => {
  res.render('user-recover', { error: null, notice: null });
});
router.post('/recover', (req, res) => {
  const userCode = String(req.body.userCode || '').trim();
  const recoveryCode = String(req.body.recoveryCode || '').trim().toUpperCase();
  const newPassword = String(req.body.newPassword || '');
  const user = db.get('users').find(u => String(u.userCode||'').trim().toLowerCase() === userCode.toLowerCase()).value();
  if (!user || !user.recoveryCodeHash || !verifyPassword(recoveryCode, user.recoveryCodeHash)) return res.render('user-recover', { error: 'Recovery details are incorrect.', notice: null });
  if (newPassword.length < 8) return res.render('user-recover', { error: 'New password must be at least 8 characters.', notice: null });
  db.get('users').find({ id: user.id }).assign({ passwordHash: hashPassword(newPassword), sessionVersion: Number(user.sessionVersion||0)+1, recoveryCodeHash: null }).write();
  res.redirect('/login?notice=' + encodeURIComponent('Password reset successfully. You can now log in.'));
});

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/account');
  res.render('user-login', { error: null, notice: req.query.notice || null });
});

router.post('/login', (req, res) => {
  const userCode = (req.body.userCode || '').trim();
  const password = req.body.password || '';
  const key = String(req.ip || '') + ':' + userCode.toLowerCase();
  const state = userAttemptState(key);
  if (state.lockedUntil > Date.now()) {
    return res.render('user-login', { error: 'Too many failed attempts. Please try again later.', notice: null });
  }
  const user = db.get('users').find((u) => String(u.userCode || '').trim().toLowerCase() === userCode.toLowerCase()).value();
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    state.count += 1;
    if (state.count >= USER_MAX_ATTEMPTS) { state.count = 0; state.lockedUntil = Date.now() + USER_LOCKOUT_MS; }
    userLoginAttempts.set(key, state);
    return res.render('user-login', { error: 'Invalid ID or password.', notice: null });
  }
  userLoginAttempts.delete(key);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Unable to start a secure session.');
    req.session.userId = user.id;
    req.session.userSessionVersion = Number(user.sessionVersion || 0);
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    res.redirect('/account');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account', requireUser, (req, res) => {
  const user = currentUser(req);
  if (!user) { delete req.session.userId; return res.redirect('/login'); }
  const lotteries = db.get('lotteries').value() || [];
  const watches = db.get('watchedNumbers').filter({ userId: user.id }).value();
  const notifications = db.get('notifications').filter({ userId: user.id }).sortBy('createdAt').reverse().value();
  res.render('user-dashboard', { user, lotteries, watches, notifications, notice: req.query.notice || null });
});

router.get('/account/lotteries', requireUser, (req, res) => {
  const lotteries = (db.get('lotteries').value() || []).map(l => ({...l, ticketStatus: ticketEntryStatus(l)}));
  res.render('user-lotteries', { lotteries, selectedId: req.query.selected || null });
});

router.get('/account/numbers/:lotteryId', requireUser, (req, res) => {
  const user = currentUser(req);
  const lottery = db.get('lotteries').find({ id: req.params.lotteryId }).value();
  if (!lottery) return res.redirect('/account/lotteries?selected=none');

  // Ticket records entered from the user panel are stored in the same
  // purchases collection as admin records. Aggregate them per number so the
  // 00-99 grid immediately shows the totals, just like the admin grid.
  const purchases = db.get('purchases').filter({ lotteryId: lottery.id, userId: user.id }).value();
  const purchaseTotals = {};
  for (let i = 0; i < 100; i++) {
    const n = String(i).padStart(2, '0');
    purchaseTotals[n] = { tickets: 0, amount: 0 };
  }
  purchases.forEach((p) => {
    const n = String(p.number).padStart(2, '0');
    if (!purchaseTotals[n]) purchaseTotals[n] = { tickets: 0, amount: 0 };
    purchaseTotals[n].tickets += Number(p.tickets) || 0;
    purchaseTotals[n].amount += Number(p.amount) || 0;
  });

  const ticketStatus = ticketEntryStatus(lottery);
  // Generate a separate idempotency key for each number form. Keep this out of
  // the EJS template so the view does not depend on Node's `require()` scope.
  const requestIds = {};
  for (let i = 0; i < 100; i++) {
    requestIds[String(i).padStart(2, '0')] = crypto.randomUUID();
  }
  res.render('user-numbers', {
    user,
    lottery,
    purchaseTotals,
    ticketStatus,
    requestIds,
    notice: req.query.notice || null,
  });
});

router.get('/account/tickets', requireUser, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const lotteries = db.get('lotteries').value() || [];
  const purchases = db.get('purchases').filter({ userId: user.id }).value().slice().sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const entries = purchases.map(p => {
    const lottery = lotteries.find(l => l.id === p.lotteryId);
    return { ...p, lotteryName: lottery ? lottery.name : 'Unknown lottery', canEdit: !!(lottery && !ticketEntryStatus(lottery).locked) };
  });
  const totalTickets = entries.reduce((s,p) => s + (Number(p.tickets)||0), 0);
  const totalAmount = entries.reduce((s,p) => s + (Number(p.amount)||0), 0);
  res.render('user-tickets', { user, entries, totalTickets, totalAmount, notice: req.query.notice || null });
});

router.get('/account/settings', requireUser, (req, res) => {
  const user = currentUser(req);
  if (!user) { delete req.session.userId; return res.redirect('/login'); }
  res.render('user-settings', { user, notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/account/settings/notifications', requireUser, (req, res) => {
  const user = currentUser(req);
  const enabled = req.body.enabled === 'on';
  db.get('users').find({ id: user.id }).assign({
    notificationsEnabled: enabled,
    notificationsWelcomeShown: user.notificationsWelcomeShown || false,
    pushSubscription: enabled ? (user.pushSubscription || null) : null,
  }).write();

  if (enabled && !user.notificationsWelcomeShown) {
    db.get('notifications').push({
      id: makeId(), userId: user.id, lotteryId: null, resultDate: null, number: null,
      title: 'Notifications enabled',
      message: 'Notifications are now turned on. You will be notified when a published result is available.',
      createdAt: new Date().toISOString(), readAt: null, type: 'welcome',
    }).write();
    db.get('users').find({ id: user.id }).assign({ notificationsWelcomeShown: true }).write();
  }
  res.redirect('/account/settings?notice=' + encodeURIComponent(enabled ? 'Notifications turned on.' : 'Notifications turned off.'));
});

router.post('/account/settings/password', requireUser, (req, res) => {
  const user = currentUser(req);
  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';
  const confirmPassword = req.body.confirmPassword || '';
  if (!verifyPassword(currentPassword, user.passwordHash)) return res.redirect('/account/settings?error=' + encodeURIComponent('Current password is incorrect.'));
  if (newPassword.length < 8) return res.redirect('/account/settings?error=' + encodeURIComponent('New password must be at least 8 characters.'));
  if (newPassword !== confirmPassword) return res.redirect('/account/settings?error=' + encodeURIComponent('New passwords do not match.'));
  const { hashPassword } = require('./utils');
  db.get('users').find({ id: user.id }).assign({ passwordHash: hashPassword(newPassword), sessionVersion: Number(user.sessionVersion || 0) + 1 }).write();
  res.redirect('/account/settings?notice=' + encodeURIComponent('Password changed successfully.'));
});

router.post('/watch', requireUser, (req, res) => {
  const user = currentUser(req);
  const lotteryId = req.body.lotteryId;
  const number = String(req.body.number || '').padStart(2, '0');
  const lottery = db.get('lotteries').find({ id: lotteryId }).value();
  if (!lottery || !/^\d{2}$/.test(number)) return res.redirect('/account/lotteries');
  const exists = db.get('watchedNumbers').find({ userId: user.id, lotteryId, number }).value();
  if (!exists) {
    db.get('watchedNumbers').push({ id: makeId(), userId: user.id, lotteryId, number, createdAt: new Date().toISOString() }).write();
  }
  res.redirect('/account/numbers/' + encodeURIComponent(lotteryId));
});

router.post('/watch/:id/delete', requireUser, (req, res) => {
  const user = currentUser(req);
  const watch = db.get('watchedNumbers').find({ id: req.params.id, userId: user.id }).value();
  db.get('watchedNumbers').remove({ id: req.params.id, userId: user.id }).write();
  if (req.body.returnTo === 'dashboard') return res.redirect('/account');
  if (watch && watch.lotteryId) return res.redirect('/account/numbers/' + encodeURIComponent(watch.lotteryId));
  res.redirect('/account/lotteries');
});

router.post('/notifications/:id/read', requireUser, (req, res) => {
  const user = currentUser(req);
  db.get('notifications').find({ id: req.params.id, userId: user.id }).assign({ readAt: new Date().toISOString() }).write();
  res.redirect('/account');
});



router.get('/notifications/public-key', requireUser, (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(404).json({ ok: false });
  res.json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/notifications/subscribe', requireUser, (req, res) => {
  const user = currentUser(req);
  const subscription = req.body.subscription;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ ok: false });
  db.get('users').find({ id: user.id }).assign({ pushSubscription: subscription }).write();
  res.json({ ok: true });
});

router.post('/notifications/unsubscribe', requireUser, (req, res) => {
  const user = currentUser(req);
  db.get('users').find({ id: user.id }).assign({ pushSubscription: null }).write();
  res.json({ ok: true });
});


// User ticket entry for lottery numbers 00-99.
// The user's account name is stored as buyerName automatically; the form only asks for tickets and amount.
router.post('/lottery/:id/purchases/:number', requireUser, (req, res) => {
  const user = currentUser(req);
  const lottery = db.get('lotteries').find({ id: req.params.id }).value();
  if (!lottery) return res.status(404).send('Lottery not found');

  const { number } = req.params;
  if (!/^\d{2}$/.test(number)) return res.status(400).send('Invalid number');

  const ticketStatus = ticketEntryStatus(lottery);
  if (ticketStatus.locked) return res.status(403).send(ticketStatus.message);

  const ticketsNum = parseInt(req.body.tickets, 10);
  const amountNum = parseFloat(req.body.amount);
  const requestId = String(req.body.requestId || '').trim();
  if (!requestId || requestId.length > 100) return res.status(400).send('Invalid submission. Please refresh and try again.');
  const duplicate = db.get('purchases').find({ userId: user.id, requestId }).value();
  if (duplicate) return res.redirect('/account/numbers/' + encodeURIComponent(lottery.id) + '?notice=' + encodeURIComponent('This ticket was already saved.'));

  if (!Number.isInteger(ticketsNum) || ticketsNum < 1 || ticketsNum > 100000) {
    return res.status(400).send('Please enter at least 1 ticket.');
  }

  if (!Number.isFinite(amountNum) || amountNum < 0 || amountNum > 10000000) {
    return res.status(400).send('Please enter a valid amount.');
  }

  db.get('purchases')
    .push({
      id: makeId(),
      lotteryId: lottery.id,
      userId: user.id,
      number,
      buyerName: (user && user.name) ? String(user.name).trim() : 'User',
      tickets: ticketsNum,
      amount: amountNum,
      requestId,
      createdAt: new Date().toISOString(),
    })
    .write();

  return res.redirect('/account/numbers/' + encodeURIComponent(lottery.id));
});

router.get('/account/tickets/:id/edit', requireUser, (req, res) => {
  const user = currentUser(req); const entry = db.get('purchases').find({ id: req.params.id, userId: user.id }).value();
  if (!entry) return res.status(404).send('Ticket not found');
  const lottery = db.get('lotteries').find({ id: entry.lotteryId }).value(); if (!lottery) return res.status(404).send('Lottery not found');
  const status = ticketEntryStatus(lottery); if (status.locked) return res.status(403).send(status.message);
  res.render('user-ticket-edit', { entry, lottery, error: null });
});
router.post('/account/tickets/:id/edit', requireUser, (req, res) => {
  const user=currentUser(req); const entry=db.get('purchases').find({ id:req.params.id,userId:user.id }).value(); if(!entry)return res.status(404).send('Ticket not found');
  const lottery=db.get('lotteries').find({id:entry.lotteryId}).value(); if(!lottery)return res.status(404).send('Lottery not found');
  const status=ticketEntryStatus(lottery); if(status.locked)return res.status(403).send(status.message);
  const ticketsNum=parseInt(req.body.tickets,10), amountNum=parseFloat(req.body.amount);
  if(!Number.isInteger(ticketsNum)||ticketsNum<1||ticketsNum>100000||!Number.isFinite(amountNum)||amountNum<0||amountNum>10000000)return res.render('user-ticket-edit',{entry,lottery,error:'Please enter valid ticket and amount values.'});
  db.get('purchases').find({id:entry.id}).assign({tickets:ticketsNum,amount:amountNum,updatedAt:new Date().toISOString()}).write();
  res.redirect('/account/tickets?notice=' + encodeURIComponent('Ticket updated successfully.'));
});

module.exports = { router, requireUser };
