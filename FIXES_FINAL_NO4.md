# Final No.4 — lottery date/cutoff fixes

- Public results now distinguish the previous completed draw from today's upcoming draw using the configured `LOTTERY_TIMEZONE` (default `Asia/Kolkata`).
- Before today's draw, the public Latest column shows `XX` plus the remaining minutes; the Previous column shows the most recent completed result.
- After today's draw, today's published result becomes Latest. If the draw has passed but the result has not been entered, Latest remains `XX` with `Result pending`.
- Ticket entry is enforced server-side at 15 minutes before the scheduled draw.
- Time parsing now accepts normal 12/24-hour formats and legacy hybrid values such as `23:07pm`, interpreting the latter as 23:07 instead of silently disabling the cutoff.
- Existing PostgreSQL/session/security and user-ticket changes in Final No.4 are preserved.