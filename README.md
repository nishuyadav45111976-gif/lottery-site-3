# Lottery Results Website

A complete website with:
- **Public pages** — anyone can see all lotteries and their results
- **Admin panel** (password protected) — add new lotteries, post/update daily results, delete old entries
- **Real backend** — Node.js + Express, with PostgreSQL-backed data and persistent sessions for production use

No coding needed to use it day-to-day — this guide covers everything from "I've never touched code" to "it's live on my domain."

---

## 1. Run it on your own computer first (recommended)

**Step 1 — Install Node.js** (one-time only)
Go to https://nodejs.org and download the "LTS" version. Install it like any normal program.

**Step 2 — Open this folder in a terminal**
- Windows: open the `lottery-site` folder, then right-click inside it and choose "Open in Terminal" (or open Command Prompt and `cd` into the folder).
- Mac: open Terminal, then type `cd ` (with a space) and drag the `lottery-site` folder into the window, then press Enter.

**Step 3 — Set your admin password**
In the folder, find the file called `.env.example`. Make a copy of it and rename the copy to `.env`. Open `.env` in any text editor and change:
```
ADMIN_PASSWORD=replace-with-a-strong-initial-password
SESSION_SECRET=please-change-this-to-something-random
```
to your own starting password and a random string of letters/numbers. (This password is only used the very first time the site starts — after that, you can change it any time from **Admin > Website Settings**, and this file is no longer used for it.)

**Step 4 — Install and start**
In the terminal, run:
```
npm install
npm start
```
You'll see: `Lottery results site running at http://localhost:3000`

**Step 5 — Open it**
Visit **http://localhost:3000** in your browser — that's your public results page.
Visit **http://localhost:3000/admin** to log in with your password and start adding lotteries.

---

## 2. How to use the admin panel

1. Go to `/admin` and log in.
2. Click **"+ Add New Lottery"** and give it a name (e.g. "Morning Draw"). Do this once per lottery — you said you have 5+.
3. Click **"Update Result"** next to a lottery, pick the date, type the result, and save.
4. Posting a result for a date that already has one **overwrites it** — so if you make a typo, just re-enter that date to fix it.
5. The public homepage always shows each lottery's most recent result. Clicking a lottery shows its full history.

In production, PostgreSQL is required and is the source of truth. The bundled JSON file is development-only and is never read by the production server.

---

## 3. Putting it on your own domain

Since this has a real backend, it needs to run on a server (not a static site host). The easiest beginner-friendly options:

### Option A: Render.com (recommended for beginners)
1. Create a free account at https://render.com
2. Push this folder to a GitHub repository (Render can walk you through this, or ask me and I'll explain that step too).
3. In Render, click **New → Web Service**, connect your GitHub repo.
4. Build command: `npm install` — Start command: `npm start`
5. Under **Environment**, add `ADMIN_PASSWORD` and `SESSION_SECRET` with your own values.
7. Once deployed, Render gives you a URL. Go to your domain registrar (GoDaddy, Namecheap, etc.) and point your domain to Render by following Render's "Custom Domain" instructions in your service settings — it's a simple copy-paste of a few DNS records.

### Option B: Railway.app
Very similar flow to Render. Attach/configure PostgreSQL and set the same production secrets; the application does not use a JSON file as a production database.

If any of this gets confusing when you get there, come back and tell me exactly what step you're on — I can walk you through it in more detail or adjust the code for whichever host you pick.

---

## 4. Production environment

Required secrets:
- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_PASSWORD` for the initial password
- `BACKUP_ENCRYPTION_KEY`

Admin 2FA is available from the Admin settings page. When it is OFF, admin login uses the password only; when it is ON, the authenticator code is required. For a public launch, enabling 2FA is strongly recommended.

Automated encrypted backups can be enabled with `BACKUP_INTERVAL_HOURS=24` and `BACKUP_DIR=./backups`. Store that directory on persistent storage or replace it with an external backup job.

Health check: `/health`

## 5. Files in this project (for reference — you don't need to edit these)

```
server.js              → starts the website
routes/public.js        → the pages everyone can see
routes/admin.js         → the admin panel logic
views/                   → the actual page designs (HTML templates)
public/css/style.css     → all the styling/colors
scripts/backup-postgres.js → encrypted automated application backup
backups/                 → encrypted backup output (keep off public web storage)
.env                     → your password & secret (never share this file)
```

---

## Security notes
- Change `ADMIN_PASSWORD` to something only you know before putting this online.
- Never commit your real `.env` file to a public GitHub repo — only commit `.env.example`.


## Production hardening in Final No.8
- PostgreSQL is required in production; the bundled JSON database is never read in production.
- PostgreSQL `app_state` is the canonical snapshot and persistence updates the canonical state plus normalized tables in one transaction with advisory locking.
- Normalized tables have constraints/indexes and a case-insensitive unique Personal ID index.
- Authenticated pages are excluded from the service-worker cache.
- Admin logout is POST + CSRF protected.
Admin 2FA is optional and can be enabled or disabled from the Admin panel.
- Backups are encrypted and exclude password hashes/TOTP secrets.
- User ticket duplicate submissions use request IDs and server-side checks.
- Ticket cutoff is enforced server-side and editable only before cutoff.
- Public analytics use privacy-friendly session IDs and PostgreSQL daily counters.
- `/health` checks database connectivity without exposing raw database errors.
- Result dates are validated against the lottery timezone and future dates are rejected.
- IDs use `crypto.randomUUID()`.


## Production hardening in Final Zip 17
- Production requires `DATABASE_URL`, `SESSION_SECRET`, `COOKIE_SECURE=true`, and `BACKUP_ENCRYPTION_KEY`.
- There is no hard-coded/default production session secret.
- There is no default/fallback admin password. The initial admin password must be supplied through `ADMIN_PASSWORD` when no admin password hash exists yet.
- The application will refuse to start in production when these required security/database settings are missing.
- Replit can provide the application hosting and a managed PostgreSQL database; a separate physical server is not required when using Replit Deployments.


## Render production deployment

This application is designed to run on a Render Web Service with Render PostgreSQL.

### Render Web Service
- Build Command: `npm install`
- Start Command: `npm start`
- Node.js: `24.x` (pinned in `package.json`)


### Required production environment variables
```text
NODE_ENV=production
DATABASE_URL=<Render PostgreSQL connection URL>
SESSION_SECRET=<long random private secret>
COOKIE_SECURE=true
BACKUP_ENCRYPTION_KEY=<long random private key>
```

`ADMIN_PASSWORD` is required only when bootstrapping a database that has no admin password hash:
```text
ADMIN_PASSWORD=<strong initial admin password>
```

### Optional backup configuration
```text
BACKUP_INTERVAL_HOURS=24
BACKUP_DIR=./backups
BACKUP_RETENTION=30
```
Local backup files are not durable production storage unless suitable persistent storage or an external backup process is configured.

### Optional browser push notifications
```text
VAPID_PUBLIC_KEY=<generated VAPID public key>
VAPID_PRIVATE_KEY=<generated VAPID private key>
VAPID_SUBJECT=mailto:<your notification email>
```

### Optional Admin 2FA issuer
```text
ADMIN_2FA_ISSUER=Lottery Results
```

Leave `PORT` unset; Render supplies it automatically.

Create a Render PostgreSQL database and use its connection URL as `DATABASE_URL`. Do not run the JSON-to-PostgreSQL migration script against an existing production database unless it has been reviewed and explicitly approved.

Never commit production secrets to Git or put them inside this ZIP.

Admin 2FA behavior remains:
- 2FA OFF: password only.
- 2FA ON: password + authenticator code.

### Render production requirements
- PostgreSQL is the authoritative production data store.

## Render production configuration

For Render deployment, the application must run with:

```text
NODE_ENV=production
DATABASE_URL=<Render PostgreSQL connection URL>
DATABASE_SSL=true
SESSION_SECRET=<strong random private secret>
COOKIE_SECURE=true
BACKUP_ENCRYPTION_KEY=<strong random private key>
LOTTERY_TIMEZONE=Asia/Kolkata
```

`DATABASE_SSL=true` and `LOTTERY_TIMEZONE=Asia/Kolkata` are required in production. The application rejects production startup if either is missing or incorrect.


Admin 2FA is optional and controlled from the Admin panel:
- 2FA OFF → password only.
- 2FA ON → password plus authenticator code.

## Authoritative Render production configuration

For Render deployment, configure the Web Service with:

```text
NODE_ENV=production
DATABASE_URL=<Render PostgreSQL connection URL>
DATABASE_SSL=true
SESSION_SECRET=<strong random private secret>
COOKIE_SECURE=true
BACKUP_ENCRYPTION_KEY=<strong random private key>
LOTTERY_TIMEZONE=Asia/Kolkata
```

`ADMIN_PASSWORD` is needed only when bootstrapping a database that has no existing admin password hash.

PostgreSQL is the authoritative production data store. A Render Persistent Disk is not required to preserve PostgreSQL lottery data.

The application loads `.env` before evaluating production configuration guards, so local `.env` testing is also consistent with the documented configuration. On Render, use Render's environment-variable settings rather than committing a `.env` file.

Admin 2FA is optional:
- 2FA OFF → password only.
- 2FA ON → password + authenticator code.

Build command: `npm install`
Start command: `npm start`

## Authoritative Render production configuration

```text
NODE_ENV=production
DATABASE_URL=<Render PostgreSQL connection URL>
DATABASE_SSL=true
SESSION_SECRET=<strong random private secret>
COOKIE_SECURE=true
BACKUP_ENCRYPTION_KEY=<strong random private key>
LOTTERY_TIMEZONE=Asia/Kolkata
```

`ADMIN_PASSWORD` is required only when bootstrapping a database that has no existing admin password hash.

PostgreSQL is the authoritative production data store. A Render Persistent Disk is not required to preserve PostgreSQL lottery data.

The application loads `.env` before evaluating production configuration guards. On Render, use Render environment variables rather than committing a `.env` file.

Admin 2FA is optional:
- 2FA OFF → password only.
- 2FA ON → password + authenticator code.

Build command: `npm install`
Start command: `npm start`
