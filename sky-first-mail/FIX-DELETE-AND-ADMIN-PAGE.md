Sky First Mail - consolidated source patch (2026-10-12)

- Removed nested duplicate sky-first-mail/ project folder from the release ZIP.
- Changed the admin dashboard from a floating modal to a dedicated full-screen workspace.
- Account deletion UI sends explicit confirmed=true only after the user presses the delete confirmation button.
- API now validates the explicit confirmation flag, while retaining self-delete and last-active-super-admin protections.

Deployment note: publish the canonical project root (the folder containing package.json, src/, public/, migrations/ and wrangler.jsonc). Verify against a staging account before production. This package has not been deployed to the live Cloudflare service.
