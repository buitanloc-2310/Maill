# Sky First Mail — Startup and Performance Fix 12.0.5

Date: 2026-10-14

## Scope

Fix the webmail entry flow that could remain indefinitely on “Đang chuẩn bị hộp thư của bạn”, reduce repeated D1 schema compatibility work on cold Worker isolates, and ensure browsers receive the updated frontend bundle. The source was modified in an isolated working copy. No Cloudflare production deployment, remote D1 migration, R2 operation, or real email send/receive test was performed.

## Changes

1. **Bounded frontend startup.** The bootstrap status, current-user, and mailbox-list requests each have a 12-second timeout. The initial message-list request has a 15-second timeout. The common API helper also has a 60-second fallback timeout and turns stalled/network requests into actionable errors.
2. **Recoverable startup state.** A failed startup replaces the splash with an error and a retry action; it no longer has to stay on the loading animation forever. A message-list failure is reported inside the mailbox view with a retry action rather than being misclassified as a bad login.
3. **Faster D1 schema checks.** Runtime compatibility checking groups column checks by table (five `PRAGMA table_info` queries rather than one per column), batches reliability-table setup when the binding supports batch, and writes `settings.runtime_schema_version`. A new isolate with the current marker skips the full compatibility DDL/column scan.
4. **Fresh browser bundle.** The web entry uses a versioned module preload/script URL for `app.js`, and the service-worker cache name is bumped so the new frontend is not hidden behind an old cached bundle.
5. **Release metadata.** Package and lock versions are both `12.0.5`; the previously missing workflow file referenced by the requirement tests is restored.

## Verification

- `npm run validate`: PASS.
- `npm run test:requirements`: PASS, 66/66 tests. Includes simulated API-timeout handling and a SQLite test proving a clean schema initializes and a second Worker-isolate simulation skips repeated schema scans.
- `npm run test:mobile`: PASS using actual frontend/CSS in Chromium with an isolated mock API; no production request or email send.
- `npm run test:composer-sanitizer`: PASS.
- `npm run test:browser`: sanitizer subtest PASS, full browser flow BLOCKED because this execution environment's Chromium organization policy blocks navigation to `127.0.0.1`.
- `npm test`: BLOCKED because `postal-mime` was unavailable in the working environment; dependency installation did not complete. The integration suite therefore has not passed here.

## Deployment boundary

This is a source fix package, not a claim that `mail.skyfirst.io.vn` has already been fixed in production. After deploying the project through its normal release process, verify `/api/bootstrap/status`, `/api/me`, `/api/mailboxes`, and `/api/messages` in a real browser and check Cloudflare Worker logs if any timeout remains. The version marker is written to the existing D1 `settings` table when runtime schema preparation succeeds; no email/account data is intentionally modified.
