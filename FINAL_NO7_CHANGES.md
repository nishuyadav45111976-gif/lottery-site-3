# Final No.7 — Public Launch Changes

Implemented the 42 selected items from Final No.6:

1. PostgreSQL is production source of truth; app_state writes use transactions/advisory locking and normalized tables have constraints/indexes.
2. Service worker never caches /account, /admin, login, recovery, or notification routes.
3. Admin logout is POST + CSRF.
4. Browser backup download is encrypted and excludes password hashes/recovery hashes/TOTP secret.
Admin 2FA is optional and can be enabled or disabled from the Admin panel.
6. User ticket submissions have request IDs, duplicate checks, and client-side submit locking.
7. PostgreSQL constraints/indexes added for users, purchases, results, watched numbers and analytics.
8. JSON fallback is disabled in production.
9. Lottery result dates are strictly validated and future result dates are rejected.
10. Production database initialization failures stop the server; /health reports DB status.
11. User ticket page has a live cutoff countdown.
12. User/admin pages show clear OPEN/CLOSED status.
13. Amount is explicitly labelled as total amount.
14. Ticket saves show confirmation messages.
15. Users can edit their own tickets before the cutoff.
16. My Tickets supports totals, status and edit links.
17. Self-service account recovery uses a one-time recovery code.
18. Mobile navigation menu added.
19. Loading/empty states and clearer messages retained/improved.
20. Accessibility improvements: skip link, labels, aria labels, larger mobile controls.
21. Admin lottery cards show OPEN/CLOSED status.
22. Admin cards show cutoff time.
23. Existing users can be searched by name/Personal ID.
24. Admin ticket entries can be searched by buyer.
25. Lottery totals are shown prominently.
26. Existing User profile remains account-ID based with numbers/tickets/amount totals.
27. Sensitive admin actions continue to be audit logged; recovery/2FA actions added.
28. Dangerous actions have confirmation prompts.
29. Admin dashboard quick summary added.
30. Admin 2FA status/regeneration management added.
31. Public upcoming lottery card added.
32. Public latest/previous/upcoming presentation clarified.
33. Mobile navigation added to public pages.
34. Public accessibility improvements added.
35. Canonical URLs, robots and sitemap metadata retained/improved.
36. /health endpoint added.
37. Privacy-friendly visit + unique-session analytics stored in PostgreSQL.
38. Encrypted automated backups supported by BACKUP_INTERVAL_HOURS and pg_dump when available.
39. Database monitoring through /health and admin dashboard status.
40. Production validation requires DATABASE_URL, SESSION_SECRET and BACKUP_ENCRYPTION_KEY.
41. Production JSON fallback removed.
42. Deployment documentation updated for PostgreSQL, 2FA, backups and health checks.

# Final No.8 corrective pass

- Removed production reads of `data/db.json`; JSON is now development-only.
- Made the PostgreSQL `app_state` snapshot and normalized projection update inside one database transaction with advisory locking.
- Hardened normalized synchronization against orphaned purchases, stale references and duplicate legacy records.
- Added a case-insensitive unique database index for user Personal IDs to prevent ambiguous logins.
- Deleting a lottery now removes its dependent ticket, watch and notification records from application state as well as results.
- Disabling a user now invalidates their active sessions.
- User logout now destroys the session.
- Admin ticket amount validation no longer silently converts invalid amounts to zero.
- Added a central error handler and server-side logging for unexpected request failures.
- Health checks no longer expose raw database error messages.
- Bumped the public service-worker cache and excluded language/session-changing URLs.
- Public navigation now exposes User Login/My Account instead of hiding it.
- Fixed the shared header/footer HTML structure for cleaner accessibility semantics.
- Updated the production schema and launch checklist to match the actual PostgreSQL architecture.