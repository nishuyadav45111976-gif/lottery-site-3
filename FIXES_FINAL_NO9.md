# Final No.9 — PostgreSQL stale-row persistence fix

## Fixed

- Fixed a production save failure where PostgreSQL normalized tables could retain rows that had already been removed from the canonical `app_state` snapshot.
- This could make a later **Add Lottery** fail on the database's unique `slug` constraint even though the lottery name/slug was no longer present in the application state.
- The same stale-row problem could affect user Personal IDs because of the case-insensitive unique index.
- The normalized PostgreSQL projection is now rebuilt exactly from `app_state` inside the existing transaction and advisory lock:
  1. dependent tables are cleared first;
  2. normalized lotteries and users are cleared;
  3. current users and lotteries are inserted from the canonical state;
  4. purchases, results, watched numbers, notifications, and audit entries are rebuilt.
- This keeps PostgreSQL's normalized tables and `app_state` consistent and removes stale unique-key conflicts.

## Verification

- JavaScript syntax checks passed for `db.js`, `routes/admin.js`, and `server.js`.
- Existing Final No.8 functionality and security changes were preserved.