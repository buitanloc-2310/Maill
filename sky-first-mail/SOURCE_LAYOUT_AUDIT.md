# Source Layout Audit — Sky First Mail 12.0.5

Date: 2026-10-14

## Canonical project root

The release ZIP contains one project root, `Sky-First-Mail/`, with `package.json`, `package-lock.json`, `wrangler.jsonc`, `src/`, `public/`, `migrations/`, `tests/`, `scripts/`, `desktop/`, `docs/`, and `.github/`.

## Archive cleanliness

The release ZIP excludes the nested legacy `sky-first-mail/` duplicate, `node_modules/`, `.git/`, `.env`, and `.dev.vars`. `SHA256SUMS.txt` covers each shipped file except itself.

## Current source and verification status

Package version: `12.0.5`. This revision improves startup timeout handling, runtime schema-check cost, and frontend cache invalidation. No remote D1 migration, production deploy, R2 data operation or real email send/receive was performed.

- `npm run validate`: PASS.
- `npm run test:requirements`: PASS — 66/66.
- `npm run test:mobile`: PASS.
- `npm run test:composer-sanitizer`: PASS.
- `npm run test:browser`: BLOCKED after sanitizer PASS because this environment's browser policy blocks local-origin navigation to `127.0.0.1`.
- `npm test`: BLOCKED because `postal-mime` could not be installed in this environment.

The package is a source fix; live production behavior must still be checked after the normal deployment process.
