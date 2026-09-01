require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../db');

function encrypt(buf) {
  const keyText = process.env.BACKUP_ENCRYPTION_KEY;
  if (!keyText) throw new Error('BACKUP_ENCRYPTION_KEY is not configured.');
  const key = crypto.createHash('sha256').update(keyText).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return JSON.stringify({ version: 1, source: 'postgresql', algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

// Records the outcome of the most recent backup attempt so the admin
// dashboard's Site Health section can surface it — including a failure,
// which previously only showed up if someone happened to check the logs.
async function recordBackupStatus(ok, detail) {
  try {
    await db.ready;
    db.set('settings.lastBackupStatus', { ok, at: new Date().toISOString(), detail: detail || '' }).write();
    await db.persistNow();
  } catch (e) {
    // If even recording the status fails, don't let that mask the original
    // backup outcome — just log it and move on.
    console.error('Could not record backup status:', e.message);
  }
}

(async () => {
  try {
    await db.ready;
    if (!db.isPostgres()) throw new Error('DATABASE_URL is required.');

    const dir = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
    fs.mkdirSync(dir, { recursive: true });

    let raw = null;
    const pgDump = process.env.PG_DUMP_BIN || 'pg_dump';
    const r = spawnSync(pgDump, [process.env.DATABASE_URL, '--format=custom', '--no-owner', '--no-privileges'], { encoding: null, maxBuffer: 1024 * 1024 * 100 });
    if (!r.error && r.status === 0) {
      raw = r.stdout;
    } else {
      console.warn('pg_dump unavailable; using encrypted application-state backup instead.');
      const payload = await db.encryptedBackup();
      raw = Buffer.from(payload);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `lottery-backup-${stamp}.enc.json`);
    fs.writeFileSync(file, encrypt(raw), { mode: 0o600 });

    const keep = Number(process.env.BACKUP_RETENTION || 30);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.enc.json')).sort().reverse();
    files.slice(keep).forEach((x) => fs.unlinkSync(path.join(dir, x)));

    console.log(`Encrypted backup written: ${file}`);
    await recordBackupStatus(true, path.basename(file));
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    await recordBackupStatus(false, e.message);
    process.exit(1);
  }
})();
