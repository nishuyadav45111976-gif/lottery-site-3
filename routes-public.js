const express = require('express');
const router = express.Router();
const db = require('./db');
const { formatTimestamp } = require('./utils');

// Results the public site should ever show — excludes soft-deleted ones
// still sitting in the admin's trash, and excludes results an admin has
// scheduled ahead of time but that haven't reached their draw time yet.
function activeResults() {
  return (db.get('results').value() || []).filter((r) => !r.deletedAt && r.published !== false);
}

function parseDrawMinutes(drawTime) {
  if (!drawTime) return null;
  const raw = String(drawTime).trim().toUpperCase().replace(/\s+/g, ' ');
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  let h, min, ap;
  if (m) {
    h = Number(m[1]); min = Number(m[2]); ap = m[3];
  } else {
    m = raw.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (!m) return null;
    h = Number(m[1]); min = 0; ap = m[2];
  }
  if (min > 59) return null;
  if (ap) {
    if (h >= 13 && h <= 23) {
      // Accept legacy hybrid values such as 23:07pm as 23:07.
    } else {
      if (h < 1 || h > 12) return null;
      if (h === 12) h = 0;
      if (ap === 'PM') h += 12;
    }
  }
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

function zonedNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

function dateString(clock) {
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

function previousDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function minutesUntilDraw(drawMinutes, nowMinutes) {
  let diff = drawMinutes - nowMinutes;
  if (diff < 0) diff += 1440;
  return diff;
}

function formatRemainingTime(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours > 0 && mins > 0) return `${hours} hr ${mins} min`;
  if (hours > 0) return `${hours} hr`;
  return `${mins} min`;
}

// Build the public-facing "previous/latest" pair around the lottery's daily
// scheduled occurrence. "Previous" is the most recently completed draw, while
// "Latest" represents today's draw/result. Before today's draw, Latest stays
// XX with the countdown instead of showing yesterday's result as Latest.
function publicResultState(lottery, results) {
  const tz = process.env.LOTTERY_TIMEZONE || 'Asia/Kolkata';
  const now = zonedNow(tz);
  const today = dateString(now);
  const drawMinutes = parseDrawMinutes(lottery.drawTime);
  const nowMinutes = now.hour * 60 + now.minute;
  const todayResult = results.find(r => r.date === today) || null;

  if (drawMinutes == null) {
    return { latestResult: results[0] || null, previousResult: results[1] || null, upcoming: null };
  }

  const beforeTodayDraw = nowMinutes < drawMinutes;
  const previousResult = todayResult
    ? results.find(r => r.date < today) || null
    : results.find(r => r.date < today) || null;

  const upcoming = !todayResult ? {
    date: today,
    drawTime: lottery.drawTime,
    minutesRemaining: beforeTodayDraw ? minutesUntilDraw(drawMinutes, nowMinutes) : 0,
    remainingText: beforeTodayDraw ? formatRemainingTime(minutesUntilDraw(drawMinutes, nowMinutes)) : null,
    pendingResult: !beforeTodayDraw,
    timezone: tz,
  } : null;

  return { latestResult: todayResult, previousResult, upcoming };
}

// Simple day-by-day visit counter — no cookies, no IPs, no per-visitor
// tracking, just a running total per calendar date. Called on real page
// views only (not the language toggle, not the JSON/XML endpoints).
async function trackVisit(req) {
  const tz = process.env.LOTTERY_TIMEZONE || 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const today = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
  return db.recordVisit(req.session.visitorId || 'anonymous', today);
}

// Toggle site language (English/Hindi), persisted in the session
router.get('/lang/:code', (req, res) => {
  req.session.lang = req.params.code === 'hi' ? 'hi' : 'en';
  const back = req.get('Referrer');
  res.redirect(back && back.startsWith(`${req.protocol}://${req.get('host')}`) ? back : '/');
});

// Homepage: show every lottery with its two most recent results side by side
router.get('/', async (req, res) => {
  await trackVisit(req);
  await db.applyAutoStar().catch(() => {});
  const lotteries = db.get('lotteries').value() || [];

  const lotteriesWithResults = lotteries.map((lottery) => {
    const results = db
      .get('results')
      .filter((r) => r.lotteryId === lottery.id && !r.deletedAt && r.published !== false)
      .sortBy('date')
      .reverse()
      .value();
    const resultState = publicResultState(lottery, results);

    return {
      ...lottery,
      latestResult: resultState.latestResult,
      previousResult: resultState.previousResult,
      upcoming: resultState.upcoming,
    };
  });

  const starredLottery = lotteriesWithResults.find((l) => l.starred) || null;
  const mainLotteries = lotteriesWithResults.filter((l) => l.isMain).slice(0, 4);

  await db.applyAutoSpecialStar().catch(() => {});
  const specialLotteries = (db.get('specialLotteries').value() || []).map((lottery) => {
    const results = db
      .get('specialResults')
      .filter((r) => r.lotteryId === lottery.id && !r.deletedAt && r.published !== false)
      .sortBy('date')
      .reverse()
      .value();
    const resultState = publicResultState(lottery, results);
    return {
      ...lottery,
      latestResult: resultState.latestResult,
      previousResult: resultState.previousResult,
      upcoming: resultState.upcoming,
    };
  });
  const starredSpecialLottery = specialLotteries.find((l) => l.starred) || null;

  // Most recent moment any result was entered or edited, for a "last updated" note
  const allResultsForTimestamp = activeResults();
  let lastUpdatedIso = null;
  allResultsForTimestamp.forEach((r) => {
    if (r.updatedAt && (!lastUpdatedIso || r.updatedAt > lastUpdatedIso)) lastUpdatedIso = r.updatedAt;
  });
  const lastUpdated = lastUpdatedIso ? formatTimestamp(lastUpdatedIso) : null;

  // Last 15 days, every lottery as a column — same shape as /history but capped to 15 dates
  const allResults = activeResults();
  const recentDates = [...new Set(allResults.map((r) => r.date))].sort().reverse().slice(0, 15);
  const recentRows = recentDates.map((date) => {
    const cells = lotteries.map((lottery) => {
      const match = allResults.find((r) => r.lotteryId === lottery.id && r.date === date);
      return match ? match.resultText : 'XX';
    });
    return { date, cells };
  });

  res.render('index', { lotteries: lotteriesWithResults, starredLottery, mainLotteries, recentRows, lastUpdated, specialLotteries, starredSpecialLottery, isHomePage: true });
});

// Single lottery page: full result history
router.get('/lottery/:slug', async (req, res) => {
  await trackVisit(req);
  const lottery = db.get('lotteries').find({ slug: req.params.slug }).value();

  if (!lottery) {
    return res.status(404).render('404');
  }

  const results = db
    .get('results')
    .filter((r) => r.lotteryId === lottery.id && !r.deletedAt && r.published !== false)
    .sortBy('date')
    .reverse()
    .value();

  res.render('lottery', { lottery, results });
});

// Same as /lottery/:slug, for Special Lotteries (000-999 games).
router.get('/special/:slug', async (req, res) => {
  await trackVisit(req);
  const lottery = db.get('specialLotteries').find({ slug: req.params.slug }).value();

  if (!lottery) {
    return res.status(404).render('404');
  }

  const results = db
    .get('specialResults')
    .filter((r) => r.lotteryId === lottery.id && !r.deletedAt && r.published !== false)
    .sortBy('date')
    .reverse()
    .value();

  res.render('special-lottery', { lottery, results });
});

// Combined history grid: every lottery as a column, every date as a row.
// Supports optional filters: ?lottery=<slug> to narrow to one lottery,
// and ?from=YYYY-MM-DD / ?to=YYYY-MM-DD to narrow the date range.
router.get('/history', async (req, res) => {
  await trackVisit(req);
  const allLotteries = db.get('lotteries').value() || [];
  const allResults = activeResults();

  const { lottery: lotterySlug, from, to } = req.query;
  const lotteries = lotterySlug
    ? allLotteries.filter((l) => l.slug === lotterySlug)
    : allLotteries;

  let dates = [...new Set(allResults.map((r) => r.date))].sort().reverse();
  if (from) dates = dates.filter((d) => d >= from);
  if (to) dates = dates.filter((d) => d <= to);

  const rows = dates.map((date) => {
    const cells = lotteries.map((lottery) => {
      const match = allResults.find((r) => r.lotteryId === lottery.id && r.date === date);
      return match ? match.resultText : 'XX';
    });
    return { date, cells };
  });

  res.render('history', {
    lotteries,
    rows,
    allLotteries,
    selectedSlug: lotterySlug || '',
    fromDate: from || '',
    toDate: to || '',
  });
});

router.get('/disclaimer', async (req, res) => {
  await trackVisit(req);
  res.render('legal-page', {
    title: 'Disclaimer',
    metaDescription: `Disclaimer for ${res.locals.siteName}.`,
    content: db.get('settings.disclaimerText').value() || '',
  });
});

router.get('/privacy', async (req, res) => {
  await trackVisit(req);
  res.render('legal-page', {
    title: 'Privacy Policy & Terms',
    metaDescription: `Privacy policy and terms of use for ${res.locals.siteName}.`,
    content: db.get('settings.privacyText').value() || '',
  });
});

router.get('/about', async (req, res) => {
  await trackVisit(req);
  res.render('legal-page', {
    title: 'About / Contact',
    metaDescription: `About and contact information for ${res.locals.siteName}.`,
    content: db.get('settings.aboutText').value() || '',
  });
});

router.get('/faq', async (req, res) => {
  await trackVisit(req);
  res.render('legal-page', {
    title: 'Frequently Asked Questions',
    metaDescription: `Frequently asked questions about ${res.locals.siteName}.`,
    content: db.get('settings.faqText').value() || '',
  });
});

// Historical "which numbers come up most often" table for one lottery
router.get('/lottery/:slug/frequency', async (req, res) => {
  const lottery = db.get('lotteries').find({ slug: req.params.slug }).value();
  if (!lottery) return res.status(404).render('404');
  await trackVisit(req);

  const results = db
    .get('results')
    .filter((r) => r.lotteryId === lottery.id && !r.deletedAt && r.published !== false)
    .value();

  const counts = {};
  results.forEach((r) => {
    (r.resultText.match(/\d{1,2}/g) || []).forEach((n) => {
      const key = n.padStart(2, '0');
      counts[key] = (counts[key] || 0) + 1;
    });
  });
  const frequency = Object.entries(counts)
    .map(([number, count]) => ({ number, count }))
    .sort((a, b) => b.count - a.count || a.number.localeCompare(b.number));

  res.render('lottery-frequency', { lottery, frequency });
});

// robots.txt — allow everything except the admin panel, point crawlers at the sitemap
router.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${base}/sitemap.xml\n`);
});

// A simple sitemap of every public page, for search engines
router.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const lotteries = db.get('lotteries').value() || [];
  const urls = [
    `${base}/`,
    `${base}/history`,
    `${base}/disclaimer`,
    `${base}/privacy`,
    `${base}/about`,
    `${base}/faq`,
    ...lotteries.map((l) => `${base}/lottery/${l.slug}`),
    ...lotteries.map((l) => `${base}/lottery/${l.slug}/frequency`),
  ];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    '\n</urlset>\n';
  res.type('application/xml');
  res.send(xml);
});

// Web app manifest, so the site can be added to a phone's home screen
router.get('/manifest.json', (req, res) => {
  const siteName = db.get('settings.siteName').value() || 'Haryana Results';
  res.type('application/manifest+json');
  res.send(
    JSON.stringify(
      {
        name: siteName,
        short_name: siteName.length > 14 ? siteName.slice(0, 14) : siteName,
        start_url: '/',
        display: 'standalone',
        background_color: '#f4f6f8',
        theme_color: '#1a9c6b',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      null,
      2
    )
  );
});

// Separate manifest for the Admin Panel, so it installs to the home screen
// as its own distinct app icon/name — pointing straight at /admin instead
// of the public homepage.
router.get('/admin-manifest.json', (req, res) => {
  const siteName = db.get('settings.siteName').value() || 'Haryana Results';
  res.type('application/manifest+json');
  res.send(
    JSON.stringify(
      {
        name: siteName + ' Admin',
        short_name: 'Admin Panel',
        start_url: '/admin',
        display: 'standalone',
        background_color: '#221912',
        theme_color: '#6B4A32',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2
    )
  );
});

module.exports = router;
