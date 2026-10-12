# Sky First Mail — Admin redesign and account management update

## Changes in this source package
- Administrator interface is rendered as a standalone full-screen workspace rather than a floating centered modal.
- Account list supports select-all, bulk delete, and bulk creation (one row per account: `Display name | local-part | password`).
- Individual and bulk deletion use an in-app confirmation layer, not browser `alert`, `confirm`, or `prompt` for the account deletion flow.
- Deletion API accepts explicit `{ "confirm": true }` from the in-app confirmation UI while retaining legacy email confirmation compatibility.
- User deletion removes user-owned messages and send operations, login history, templates, and drafts before deleting the user. The API verifies the final user row was deleted and reports failures to the UI.
- Removed the duplicate nested `sky-first-mail/sky-first-mail` source tree from the release archive.

## Verification performed
- `node --check public/app.js`
- `node --check src/index.js`
- `node --check public/v5.js`
- `node --check public/v4.js`
- Archive structure checked for duplicate nested project root.

## Not verified in this environment
- Cloudflare production deployment, D1 foreign-key state and R2 deletion, because no live environment credentials/logs are available.
- Browser end-to-end tests against the production domain.

Deploy to a staging Worker and test one disposable user before using bulk delete in production. Take a D1 backup first.
