# Source Inventory — Sky First Mail v12.0.5

- **Archive revision:** Startup/performance fix, 2026-10-14.
- **File count in compact package:** 99 files (maximum requested: 100). Five non-runtime historical documents were omitted to meet the extraction file-count limit; application source, assets, migrations, tests, scripts, package manifests and core release notes are retained.
- **Application/package version:** `sky-first-mail` 12.0.5.
- **Canonical root in ZIP:** `Sky-First-Mail/`.
- **Source baseline:** `Maill-main(2).zip`, with the nested legacy duplicate omitted from the release package and startup/runtime improvements applied to the canonical project.

## Main components

- Worker/API: `src/index.js` and `src/lib/`.
- Webmail frontend: `public/app.js`, `public/v3.js`, `public/v4.js`, `public/v5.js`, stylesheet and PWA assets.
- D1 migrations: `migrations/0001_base.sql` through `migrations/0008_transport_domains.sql`.
- Automated tests: `tests/mail.test.mjs`, `tests/requirements.test.mjs`, `tests/db.mjs`.
- Browser/mobile smoke: `scripts/browser-smoke.cjs`, `scripts/composer-sanitizer-smoke.cjs`, `scripts/mobile-layout-smoke.cjs`.
- Windows desktop shell: `desktop/`.
- CI: `.github/workflows/build-windows.yml`.

## What changed in v12.0.5

- Startup API waits are bounded, with clear retry UI instead of an indefinite splash.
- Failure to load messages is separated from authentication failure.
- Runtime schema compatibility checks are grouped by table and memoized through a shared D1 schema-version marker.
- `app.js` uses a versioned URL and the service-worker cache name is bumped to avoid stale frontend code after deployment.
- `package.json` and `package-lock.json` are synchronized at version 12.0.5.

See `STARTUP-PERFORMANCE-FIX-20261014.md` for details and verification limits.
