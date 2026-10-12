# Sky First Mail — Admin CRUD Fix (12/10/2026)

## What changed

- Rebuilt the system administration area as a dedicated full-page workspace inside the app; removed the floating admin-page overlay.
- Fixed the admin dialog stacking order so **Edit account**, **Create account**, alias and domain dialogs are clickable above the admin page.
- Fixed admin tab rendering and implemented an isolated Chromium smoke test for edit/save, single create/delete, bulk create/delete, in-app confirmation, and JavaScript/native-dialog errors.
- Kept confirmations and notifications inside the page; account administration flows do not call browser `alert()`, `confirm()` or `prompt()`.
- Account creation and bulk creation now report per-row errors; bulk creation preserves only failed rows for a retry and refreshes the account list after successful creates.
- Account deletion explicitly removes rows from `inbound_receipts`, `messages`, `send_operations`, `login_history`, `mail_templates`, and `compose_drafts` in a guarded D1 batch before deleting the user. Other dependent records continue to follow their schema's foreign-key rules.
- Account deletion only reports success after the user-row deletion commits. Audit logging, notification and post-delete object cleanup failures are logged separately and cannot turn a committed deletion into a false “delete failed” response.
- Unhandled `/api/admin/users...` server errors return a specific safe error code/message and log technical details server-side instead of exposing the generic application message.
- Added `npm run test:admin` for the isolated browser CRUD smoke test.

## Validation performed

- `npm run validate` — passed.
- `node --test tests/requirements.test.mjs` — 62 passed.
- `npm run test:admin` — passed in headless Chromium with an isolated mocked API: edit/save, single create/delete, bulk create of 2 users, bulk delete of 2 users, dialogs above page, no native browser dialogs, and no frontend JS errors.
- `npm run test:mobile` — passed on the configured viewport set without horizontal overflow.
- `npm run test:composer-sanitizer` — passed.
- Applied migrations to a local SQLite database and simulated account deletion with mailbox/draft/history/template/inbound receipt dependencies — passed, with account and dependent mailbox/receipt removed and the final active super-admin protection retained.

## Deployment limitation

This ZIP is source code; it has **not** been deployed to the production Cloudflare Worker/Pages environment. The Chromium CRUD test mocks the API, and the SQLite test is local. After deployment, back up the remote D1 database and test using a disposable account. If production still returns an error, use the `ADMIN_DELETE_*` / `ADMIN_USER_*` code and `ADMIN_USER_DELETE_FAILED` log stage from Cloudflare Logs to pinpoint any production-only schema/configuration difference.
