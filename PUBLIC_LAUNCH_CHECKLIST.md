# Public launch checklist — Production hardened

## Required before launch
- Set `NODE_ENV=production`.
- Set a long random `SESSION_SECRET` in Replit Secrets.
- Use HTTPS and `COOKIE_SECURE=true`.
- Configure `DATABASE_URL`; PostgreSQL is mandatory in production.
- Configure `DATABASE_SSL=true` when your provider requires SSL.
- Set `ADMIN_PASSWORD` only for the initial admin bootstrap (the stored password is hashed in PostgreSQL).
- Set `BACKUP_ENCRYPTION_KEY` and verify an encrypted backup can be created.
- Set `BACKUP_INTERVAL_HOURS=24` and use persistent/private backup storage.
- Set `LOTTERY_TIMEZONE=Asia/Kolkata`.
- Strongly recommended: enable Admin 2FA before public launch. The existing ON/OFF control remains intentional: when OFF, admin login uses the password only; when ON, an authenticator code is required.
- Test two different user accounts in two separate browsers/devices. Each account must see only purchases whose `userId` matches its own session.
- Test create lottery, edit lottery, delete lottery, create user, disable user, reset user password, add/edit ticket, publish/edit result, and admin logout.
- Test a duplicate ticket submission and confirm only one record is created.
- Test a result with a future date and confirm it is rejected.
- Test a draw within 15 minutes of cutoff and confirm ticket entry is closed.
- Test `/health` and confirm it reports PostgreSQL as healthy.

## Important migration note
- Production no longer reads `data/db.json`. The JSON file is development-only.
- For an existing installation, run `node scripts/migrate-to-postgres.js` once before switching production traffic to the PostgreSQL-only configuration.
- If an old database contains duplicate user IDs differing only by letter case, resolve those accounts before the case-insensitive PostgreSQL index is created. This prevents ambiguous login behavior.

## Security
- CSRF protection is enabled for state-changing requests.
- Admin and user sessions regenerate after successful login.
- User password resets and account disabling invalidate existing user sessions.
- Admin password changes and 2FA regeneration invalidate admin sessions.
- Authenticated pages are excluded from the service-worker cache.
- Backups are encrypted and application-state backups omit password hashes, recovery-code hashes and TOTP secrets.
- The public health endpoint does not expose raw database error messages.

## Operations
- Keep backups outside `public/` and outside source control.
- Monitor `/health` and the server logs for persistence failures.
- Keep `backups/` private and verify restore procedures periodically.


## Production hardening applied in Final Zip 17
- No hard-coded/default session secret is used.
- Production refuses to start without a strong `SESSION_SECRET`.
- Production refuses to start without `DATABASE_URL`.
- Production refuses to start unless `COOKIE_SECURE=true`.
- No default/fallback admin password is used. A real `ADMIN_PASSWORD` is required only when the database does not yet contain an admin password hash.
- The bundled JSON database remains development-only and is never used as a production fallback.
- Existing lottery, user, purchase, result, login, and Admin 2FA ON/OFF behavior was preserved.

## Render production checklist
- [ ] Create a Render Web Service.
- [ ] Create a Render PostgreSQL database.
- [ ] Set NODE_ENV=production.
- [ ] Set DATABASE_URL to the Render PostgreSQL connection URL.
- [ ] Set DATABASE_SSL=true.
- [ ] Set a strong private SESSION_SECRET.
- [ ] Set COOKIE_SECURE=true.
- [ ] Set a strong private BACKUP_ENCRYPTION_KEY.
- [ ] Set LOTTERY_TIMEZONE=Asia/Kolkata.
- [ ] Set ADMIN_PASSWORD only when bootstrapping a database with no admin password hash.
- [ ] Keep production secrets out of Git and the ZIP.
- [ ] Use PostgreSQL as the authoritative production data store.
- [ ] Verify /health reports PostgreSQL as healthy after deployment.
- [ ] Verify admin/user login, 2FA, lotteries, tickets, results and history against production before public launch.

## SEO / discoverability
- [x] Page `<title>` and meta description tags on key pages — already existed.
- [x] Auto-generated `/sitemap.xml` — already existed, now also includes Disclaimer/Privacy/About and each lottery's frequency page.
- [x] `robots.txt` — already existed.
- [x] `noindex` on private pages (admin/account/login/recover) — already existed.
- [x] Canonical tag in the page header — already existed.
- [x] One `<h1>` per public page with its main keyword — already in place (site name / lottery name).
- [x] Alt text on images — not applicable, the site uses emoji/SVG icons, no `<img>` tags exist.
- [x] Disclaimer page — built at `/disclaimer`, content editable from admin.
- [x] Privacy Policy & Terms page — built at `/privacy`, content editable from admin.
- [x] About Us / Contact page — built at `/about`, content editable from admin.
- [x] "Edit Pages" admin section (`/admin/pages`) — edit Website Name, Disclaimer, Privacy, About text, saved to the database, live immediately.
- [x] Website Name moved out of Website Settings into Edit Pages.
- [ ] Submit the site to Google Search Console once live on the real domain (external, do this after custom domain is live).
- [ ] Submit the site to Bing Webmaster Tools (external).
- [ ] After going live on the custom domain: verify HTTPS is working correctly and confirm the paid Render plan isn't sleeping between requests.

## New feature idea (Nishu) — all built
- [x] Scheduled result publishing: on the Update Result page, choose "Publish immediately" or "Save now, go live automatically at [draw time]." A background check every 30 seconds publishes any due result automatically, notifying followers at that moment — no need to be online right at the draw time.
- [x] Auto-refresh: home page and each lottery page quietly reload when the visitor returns to the tab/app after being away, so they see the latest result without manually refreshing.
- [x] Small WhatsApp/Telegram share buttons under the lottery name on each result page.
- [x] "Number Frequency" page per lottery (`/lottery/<slug>/frequency`) showing how often each number has appeared, linked from the result page.
- [ ] Uptime monitoring (e.g. UptimeRobot) — external setup, not code, still to do.
- [x] Bot/spam protection on login — already existed (temporary lockout after repeated wrong attempts, both admin and user login). There's no public signup form (only admins create user accounts), so nothing further was needed there.
- [x] Admin-only visitor counter — already existed on the Site Stats page (daily visits, last 14 days, busiest lottery).
- [x] `manifest.json` + one-time "Install App" prompt — the manifest and install-prompt logic already existed; both were already wired up correctly.

## Still to verify once deployed
- [ ] Visit `/admin/pages` and fill in your real Disclaimer/Privacy/About/FAQ text (starter placeholder text is pre-filled, but review and personalize it).
- [ ] Test scheduling a result during a lottery's closing window and confirm it goes public automatically at the draw time.
- [ ] Click the WhatsApp/Telegram share buttons on a live lottery page and confirm they open correctly.
- [ ] Visit `/lottery/<slug>/frequency` for one of your lotteries and confirm the numbers look right.

## Second feature batch — polish (all built)
- [x] Open Graph tags — already existed (og:title, og:description, og:url); added Twitter card tags too for broader link-preview compatibility.
- [x] FAQ page at `/faq`, content editable from Edit Pages, linked in the nav menu, included in the sitemap.
- [x] Admin CSV export of a lottery's result history (`/admin/lottery/<id>/results/export.csv`), linked on the Update Result page. Ticket-purchase CSV export already existed.
- [x] User's own ticket history CSV export (`/account/tickets/export.csv`), linked on the My Tickets page.
- [x] Scheduled-result preview: the Update Result page now shows exactly when a scheduled result will go live and a live countdown (e.g. "goes live at 8:00 AM (in 12 minutes)").
- [x] Favorite/pin lotteries: users can star a lottery on the Choose Lottery page; favorited lotteries sort to the top of the list.
- [x] 404 page — already existed and already links back home; no changes needed.
- [x] History page search/filter by lottery and date range — already existed; no changes needed.
- [x] Loading indicator: a thin progress bar now shows across the top of the page during normal navigation between pages, so it doesn't feel like nothing is happening while a page loads. (This does not fix the Render free-tier cold-start wait itself — that's still solved only by upgrading to a paid plan.)