const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { makeId, digitsOnly } = require('./utils');
const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;
const MAX_WEBHOOK_MESSAGES = 25;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;
const rateBuckets = new Map();

function normalizePhone(value) {
  const raw = String(value || '').trim();
  const digits = digitsOnly(raw);
  return digits ? `+${digits}` : '';
}

function normalizeText(value) {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function parsePersonalRecordMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'Empty message.' };
  if (raw.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'Message is too long.' };
  const match = raw.match(/^(.+?)\s+([0-9]{1,2}(?:\s*,\s*[0-9]{1,2})*)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?$/i);
  if (!match) return { ok: false, error: 'Expected: category followed by comma-separated entries and an optional amount.' };
  const categoryText = normalizeText(match[1]);
  const entries = match[2].split(',').map(v => v.trim().padStart(2, '0'));
  const amount = match[3] == null ? null : Number(match[3]);
  if (!entries.length || entries.length > 100 || entries.some(n => !/^\d{2}$/.test(n))) return { ok: false, error: 'Invalid entries.' };
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 100000000)) return { ok: false, error: 'Invalid amount.' };

  const aliases = db.get('whatsappCategoryAliases').value() || [];
  const lotteries = db.get('lotteries').value() || [];
  const candidates = [];
  lotteries.forEach(l => {
    if (normalizeText(l.name) === categoryText || normalizeText(l.slug) === categoryText) candidates.push(l);
  });
  aliases.filter(a => a.active !== false && normalizeText(a.alias) === categoryText).forEach(a => {
    const l = lotteries.find(x => x.id === a.lotteryId);
    if (l && !candidates.some(c => c.id === l.id)) candidates.push(l);
  });
  if (candidates.length !== 1) return { ok: false, error: candidates.length > 1 ? 'The category name is ambiguous.' : 'Category not recognized.', categoryText, entries, amount };
  return { ok: true, category: { id: candidates[0].id, name: candidates[0].name }, entries, amount };
}

function verifySignature(req) {
  // In production, an app secret is mandatory. Never accept unsigned webhook
  // requests just because a secret was omitted from the environment.
  const secret = String(process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret || !req.rawBody) return false;
  const header = String(req.get('x-hub-signature-256') || '');
  if (!/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rateLimited(req) {
  const now = Date.now();
  const key = String(req.ip || 'unknown');
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start >= RATE_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 2000) {
    for (const [k, v] of rateBuckets) if (now - v.start >= RATE_WINDOW_MS) rateBuckets.delete(k);
  }
  return bucket.count > RATE_MAX_REQUESTS;
}

function isAllowedSender(sender) {
  const configured = [
    db.get('settings.whatsappTestNumber').value(),
  ].map(normalizePhone).filter(Boolean);
  // If a test sender is configured, it becomes an explicit allow-list. If it
  // is blank, the webhook can still be connected to Meta, but sender filtering
  // remains disabled until the admin supplies a test number.
  return !configured.length || configured.includes(sender);
}

function isExpectedRecipient(value) {
  const configured = normalizePhone(db.get('settings.whatsappBusinessNumber').value());
  if (!configured) return true;
  return !value || normalizePhone(value) === configured;
}

// Meta webhook verification.
router.get('/webhook', (req, res) => {
  const verifyToken = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  if (!verifyToken) return res.status(503).send('WhatsApp verification is not configured.');
  const mode = String(req.query['hub.mode'] || '');
  const supplied = String(req.query['hub.verify_token'] || '');
  if (mode === 'subscribe' && supplied === verifyToken) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
});

// Incoming WhatsApp events. This version stores and parses personal-record messages,
// but intentionally does not create financial or betting transactions.
router.post('/webhook', async (req, res) => {
  if (rateLimited(req)) return res.status(429).send('Too many requests.');
  if (!verifySignature(req)) return res.sendStatus(403);
  if (!db.get('settings.whatsappRecordsEnabled').value()) return res.sendStatus(503);

  const payload = req.body;
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return res.status(400).send('Invalid WhatsApp webhook payload.');
  }
  if (payload.entry.length > 10) return res.status(413).send('Webhook payload too large.');

  // Acknowledge only after authenticity and basic schema checks. Meta can then
  // retry malformed/failed requests rather than treating them as successful.
  try {
    for (const entry of payload.entry) {
      const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change && change.value;
        if (!value || !isExpectedRecipient(value.metadata && value.metadata.display_phone_number)) continue;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        if (messages.length > MAX_WEBHOOK_MESSAGES) return res.status(413).send('Too many messages in webhook.');
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];

        for (const msg of messages) {
          if (!msg || msg.type !== 'text' || !msg.id) continue;
          const sender = normalizePhone(msg.from);
          if (!sender || !isAllowedSender(sender)) continue;
          const text = msg.text && typeof msg.text.body === 'string' ? msg.text.body.slice(0, MAX_MESSAGE_LENGTH) : '';
          const parsed = parsePersonalRecordMessage(text);
          const incoming = db.get('whatsappIncomingMessages').value() || [];
          if (incoming.some(x => x.messageId === msg.id)) continue;
          const contact = contacts.find(c => normalizePhone(c && c.wa_id) === sender);
          incoming.push({
            id: makeId(),
            messageId: String(msg.id).slice(0, 200),
            senderPhone: sender,
            displayName: contact && contact.profile ? String(contact.profile.name || '').slice(0, 200) : '',
            rawText: text,
            parsed,
            status: parsed.ok ? 'parsed' : 'needs_review',
            receivedAt: new Date().toISOString(),
          });
          db.set('whatsappIncomingMessages', incoming.slice(-5000)).write();
        }
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('WhatsApp webhook processing failed:', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
