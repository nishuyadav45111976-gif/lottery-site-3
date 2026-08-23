# Final Zip 17 — Production hardening changes

Applied to the uploaded Final Zip 16.

## Changed
- Removed the hard-coded/fixed session-secret fallback from production behavior.
- Production now requires a real `SESSION_SECRET` and rejects the known example/fallback values.
- Production now explicitly requires `DATABASE_URL`.
- Production now explicitly requires `COOKIE_SECURE=true`.
- Removed the `changeme123` default admin-password fallback.
- A real `ADMIN_PASSWORD` is required when the database does not already contain an admin password hash.
- Cleaned `.env.example` so it no longer contains usable placeholder secret values.
- Updated the public-launch checklist and README to reflect the actual production requirements.
- Removed the old dashboard warning that depended on the insecure session-secret fallback.
- Preserved existing lottery functionality, PostgreSQL source-of-truth behavior, login/session behavior, and the existing Admin 2FA ON/OFF behavior.

## Not changed / not possible from a ZIP
These are deployment/environment resources, not code inside the ZIP:
- The actual production PostgreSQL database must be provisioned in Replit (or another PostgreSQL provider).
- The actual production `DATABASE_URL` must be supplied by that database.
- A strong private `SESSION_SECRET` must be created and stored in Replit Secrets.
- The real initial `ADMIN_PASSWORD` must be stored in Replit Secrets.
- `BACKUP_ENCRYPTION_KEY` must be created and stored in Replit Secrets.
- The production deployment itself must be created/published in Replit.

No real secrets were inserted into the ZIP.