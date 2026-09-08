const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { makeId, digitsOnly } = require('./utils');
const router = express.Router();

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
  const match = raw.match(/^(.+?)\s+([0-9]{1,2}(?:\s*,\s*[0-9]{1,2})*)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?$/i);
  if (!match) return { ok: false, error: 'Expected: category followed by comma-separated entries and an optional amount.' };
  const categoryText = normalizeText(match[1]);
  const entries = match[2].split(',').map(v => v.trim().padStart(2, '0'));
  const amount = match[3] == null ? null : Number(match[3]);
  if (!entries.length || entries.some(n => !/^\d{2}$/.test(n))) return { ok: false, error: 'Invalid entries.' };
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return { ok: false, error: 'Invalid amount.' };

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
  const secret = String(process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = String(req.get('x-hub-signature-256') || '');
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta webhook verification.
router.get('/webhook', (req, res) => {
  const verifyToken = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  if (!verifyToken) return res.status(503).send('WhatsApp verification is not configured.');
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) return res.status(200).send(String(req.query['hub.challenge']));
  return res.sendStatus(403);
});

// Incoming WhatsApp events. This version stores and parses personal-record messages,
// but intentionally does not create financial or betting transactions.
router.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    const value = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    const messages = value && Array.isArray(value.messages) ? value.messages : [];
    for (const msg of messages) {
      if (!msg || msg.type !== 'text' || !msg.id) continue;
      const incoming = db.get('whatsappIncomingMessages').value() || [];
      if (incoming.some(x => x.messageId === msg.id)) continue;
      const sender = normalizePhone(msg.from);
      const text = msg.text && msg.text.body ? String(msg.text.body) : '';
      const parsed = parsePersonalRecordMessage(text);
      incoming.push({
        id: makeId(), messageId: msg.id, senderPhone: sender,
        displayName: value.contacts && value.contacts[0] && value.contacts[0].profile ? String(value.contacts[0].profile.name || '') : '',
        rawText: text, parsed, status: parsed.ok ? 'parsed' : 'needs_review',
        receivedAt: new Date().toISOString(),
      });
      db.set('whatsappIncomingMessages', incoming.slice(-5000)).write();
    }
  } catch (err) {
    console.error('WhatsApp webhook processing failed:', err);
  }
});

module.exports = router;
