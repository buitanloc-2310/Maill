# Sky First Mail — Audit and repair report R3

**Date:** 12 October 2026  
**Scope:** Continued source repair on the existing ZIP; no production deployment, live D1/R2 mutation, or live provider send/receive was performed. This is not production acceptance.

## New repair in R3

- Fixed an RFC-style recipient-header folding defect in `src/lib/mail.js`. When a long `To`/`Cc` line wrapped, the previous implementation could omit the comma before the next folded recipient. The fix retains each comma on continuation lines.
- Added an execution test using the production MIME builder extracted from `src/lib/mail.js`; it generates a long `To` header and verifies that all 18 recipients and all 17 separators remain present after folding.
- Added `SOURCE_LAYOUT_AUDIT.md` to disambiguate the active project root from the preserved, nested version-5 legacy snapshot. The older tree was not merged or removed.

## Changes retained from R2 and earlier repair work

1. Protected first-run bootstrap with server-side `SETUP_SECRET` (minimum 24 characters), a one-time atomic claim, and a recovery path when no active Super Admin was created.
2. Added account/IP login rate limiting, timestamp-based session expiry checks, session invalidation following credential/admin-reset changes, and server-side RBAC safeguards. Regular admins cannot elevate regular users or manage peer/admin accounts; last active Super Admin protections are performed in conditional SQL statements.
3. Put account creation and related rows into a database batch; made account deletion remove the account's own message/send-operation rows in a guarded batch before storage cleanup.
4. Made R2 cleanup retain objects while they are referenced by messages, attachments, drafts, send operations, avatars, or cover images; cleanup fails closed if the reference check fails.
5. Added request/inbound-stream byte limits; bounded query inputs, pagination, display names, contacts, draft content, attachment count and aggregate size.
6. Restricted inline images and avatars to supported raster types with matching byte signatures. Active attachment formats are downloaded instead of rendered inline; malformed Unicode filenames are normalized before header encoding.
7. Tightened inbound domain gating and receipt deduplication. Ownership verification compares the exact TXT token and now exposes the required record/health information in the admin UI; sending cannot be enabled before verification and transport configuration.
8. Corrected MIME nesting for `multipart/mixed` → `multipart/related` → `multipart/alternative`, UTF-8 encoded subject headers, safe file-name headers, ordinal/unique inline-CID mapping, BCC omission from visible MIME headers, and external transport handling for mixed local/external recipients.
9. Resend attachment mapping no longer infers image CID from filenames; provider 2xx replies without message IDs are treated as uncertain rather than completed. The configured MTA gateway refuses attachments until its contract actually supports them rather than silently dropping them.
10. Hardened received-message rendering: sanitize before inserting into the DOM, validate link schemes, force safe external links into new tabs, block active markup, apply a sandbox/CSP to the email frame, and require opt-in before fetching external images.
11. Improved the mobile navigation bar so mailbox folders and contacts/admin shortcuts remain reachable by horizontal swipe.
12. Preserved the old nested version-5 source tree and added guidance identifying version 12.0.1 at the root as canonical. Added/retained Windows CI workflow and requirement tests.

## Verification performed on the current tree

| Check | Result | Evidence/limit |
|---|---|---|
| `npm run validate` | **PASS** | Node syntax checks for the Worker, mail/auth/security/composer/transport/policy/stream modules, frontend scripts, and desktop entry. |
| `npm run test:requirements` | **PASS — 56/56** | Executed successfully on 2026-10-12, including the new long-recipient folding regression. |
| D1 migration sequence | **PASS** | The requirements suite executes all eight migrations against in-memory SQLite and verifies the 23-table schema plus `PRAGMA foreign_key_check`. |
| `npm test` / mail integration suite | **BLOCKED** | The suite fails before executing tests because `postal-mime` is absent from the generated local `node_modules`; npm registry DNS is unavailable from this environment, so dependency installation cannot be completed here. This is not counted as a test pass. |
| Browser E2E / screenshot | **BLOCKED / NOT VERIFIED** | `scripts/browser-smoke.cjs` imports Playwright, but Playwright is not declared in the root `package.json` and is not installed here; the local Chromium smoke attempt did not complete. The responsive changes therefore have source/regression checks, not successful browser evidence. |
| Real provider email, Gmail/Outlook/Proton/Yahoo/Fastmail, DNS/MX/SPF/DKIM/DMARC | **NOT RUN** | Requires reachable external services and configured test domains/credentials. |
| Production D1/R2, load test, backup/restore, security penetration test | **NOT RUN** | No production access or mutation used. |
| Windows installer | **NOT BUILT** | CI workflow is present, but the installer has not been built and run on Windows in this session. |

## Remaining gates — do not mark PASS

- Restore npm registry/dependency access, install from the committed lockfile, and run `npm test` to completion.
- Declare and lock Playwright as a development dependency (or replace the browser smoke harness with a supported declared test runner), then run the browser smoke test in CI and inspect desktop/mobile artifacts. This remains a known test-tooling gap.
- In staging, test authentication/RBAC, account deletion/reference retention, inbound deduplication, MIME parsing/rendering, CID images, attachment downloads, external links, Cc/Bcc, retries and provider idempotency.
- Test DNS ownership and mail delivery against owned domains; validate MX, SPF, DKIM, DMARC, bounce/complaint handling and actual cross-provider presentation.
- Run throughput/size/recovery testing and build/install/uninstall the Windows installer.

## Release status

**Partially repaired and source/regression-checked; not fully verified, not production-ready by evidence in this report.** Do not deploy this ZIP merely because the 56 requirement tests pass. The email suite and browser/provider/infrastructure gates above remain open.
