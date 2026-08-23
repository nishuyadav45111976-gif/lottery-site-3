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