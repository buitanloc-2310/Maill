# Sky First Mail — Source Inventory R7 CLEAN

- **Archive revision:** R7 CLEAN (packaging and inventory cleanup only; application source package version remains **12.0.3**).
- **Canonical project folder:** `Sky-First-Mail/`.
- **Source baseline:** the canonical top-level project from R6 (`Maill-main/sky-first-mail/`).
- **Application code:** preserved; this cleanup is not a new feature patch and does not mean the whole service is release-certified.

## Archive structure verification

The R6 input ZIP had 114 files total. It contained a second, nested project folder at `Maill-main/sky-first-mail/sky-first-mail/` with package version **5.0.0**. It was a legacy source snapshot, not a `.zip` file. The nested snapshot had 24 files, no unique relative file paths compared with the canonical version, and 13 same-path files had different contents. This is ambiguous and can cause the wrong tree to be opened. **That nested project snapshot is excluded from this distribution.** The original R6 ZIP was left untouched as a separate file outside this archive.

The clean bundle has one top-level project directory, no nested archive file, no nested duplicate project directory, no `node_modules`, no `.git`, and no `.env`/`.dev.vars` credential file found in the input canonical tree.

## Inventory by area

The 90 canonical project files copied from the current source tree are counted below; the two inventory/checksum files added for this package are not included in these area counts.

| Area | Files |
|---|---:|
| `src` | 11 |
| `public` | 23 |
| `migrations` | 8 |
| `tests` | 3 |
| `scripts` | 5 |
| `desktop` | 3 |
| `.github` | 1 |
| `docs` | 15 |
| `root documentation/config` | 21 |
| **Source files copied** | **90** |

## Important source layout

- Worker entry: `src/index.js`.
- Libraries: `src/lib/`.
- Static webmail frontend and PWA assets: `public/`.
- D1 SQL migrations: `migrations/` (8 files, `0001` through `0008`).
- Test files: `tests/` (3 files).
- Utility/smoke test scripts: `scripts/` (5 files).
- Desktop shell and Windows build metadata: `desktop/` (3 files; **no `desktop/package-lock.json` is present**).
- CI workflow: `.github/workflows/build-windows.yml`.
- Root dependency lock: `package-lock.json` lockfile v3; `package.json` and lock root both identify `sky-first-mail` version `12.0.3`, and their root dependency declarations match.
- Documentation and R6 mobile smoke evidence remain in `docs/` and root Markdown files.

## Duplicate asset audit

The files `public/sky-first-logo.png` and `public/sky-first-brand-logo.png` are byte-identical (SHA-256 `1288b93c4635af5e15762ed30ed196f50d289d2a0314e59e77417e133f8a54c9`). Both are retained in this package to avoid changing any possible public asset URL compatibility.

## Verification run against canonical source before packaging

| Command/check | Result | Notes |
|---|---|---|
| `npm run validate` | **PASS** | Node syntax checks in the script completed successfully. |
| `npm run test:requirements` | **PASS — 62/62** | All 62 tests passed. |
| `npm run test:mobile` | **PASS** | Real Chromium DOM with isolated mock API; viewports 320, 360, 390, 430, 768, 844x390, 932x430, and 1440; no network/production mail. |
| `npm run test:composer-sanitizer` | **PASS** | Real Chromium DOMParser sanitizer smoke passed. |
| `npm test` | **BLOCKED** | `ERR_MODULE_NOT_FOUND: postal-mime`; dependencies are not installed in this environment. This is not a passing integration test. |
| `npm run test:browser` | **BLOCKED** | Sanitizer subtest passed, but full local-server E2E failed because the environment blocks `127.0.0.1` (`URLBlocklist`/organization policy). |
| Live provider-to-provider email | **NOT RUN** | No real outbound test email was sent. |
| Windows installer build/install | **NOT RUN** | No `.exe` artifact or Windows installation test was produced here. |
| Production deployment/data changes | **NOT RUN** | No production deploy, remote migration, or production data mutation was performed. |

## Checksum file

`SHA256SUMS.txt` contains a SHA-256 entry for every file in this folder except itself. The archive checksum is reported separately with the download link. Re-run the included commands only after installing dependencies from `package-lock.json`; do not treat blocked tests as PASS.
