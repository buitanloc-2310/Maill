# Sky First Mail — Final Release Gate

Date: 2026-10-10

## Result

**Source/static validation: PASS. Full release: NOT PASS yet.** The current environment cannot resolve `registry.npmjs.org`, so the real MIME parser package is absent from `node_modules`; it also cannot install Electron tooling or build a Windows installer here. These gates are explicitly marked blocked, not passed.

## Results captured in this session

| Gate | Command / evidence | Result |
|---|---|---|
| Worker/frontend/desktop JS syntax | `npm run validate` (includes `node --check desktop/main.cjs`) | PASS |
| Requirement, template and static security tests | `npm run test:requirements` | PASS — 12 tests, 0 failures |
| Full mail/API/MIME integration | `npm test` | BLOCKED before tests start: `ERR_MODULE_NOT_FOUND` for `postal-mime` because the installed package directory is empty |
| Dependency restoration | `npm ci --no-audit --no-fund` | BLOCKED / timeout; DNS lookup to `registry.npmjs.org` fails in this environment |
| Windows installer | `cd desktop && npm run build:win` | BLOCKED: `electron-builder: not found`; this runtime is Linux and network install is unavailable |
| Production deployment | Not run | Intentionally not deployed |

## What passed in the source gate

1. Email HTML sanitizer static cases.
2. Exactly five HTML templates and ten text/chat snippets exist.
3. PWA manifest icon paths exist; service worker avoids caching API responses.
4. Windows installer metadata and GitHub Actions workflow are present.
5. Attachment count and aggregate-size caps match between compose, API and UI (100 combined files, 12 MiB total).
6. `package.json` and lockfile root dependency metadata agree.
7. Compose retains a stable request ID across retries.
8. Remote images in received messages require user opt-in.
9. Proofline hash/API/UI source wiring is present.
10. Electron renderer has context isolation, no Node integration, sandboxing and navigation restrictions.
11. Logo/icon binary signatures and expected PNG dimensions validate.
12. Web entry references its expected local assets, all of which exist.

## Required actions before a full PASS

1. On a network-enabled Node 22 environment, run `npm ci --no-audit --no-fund`, then `npm run validate`, `npm run test:requirements`, and `npm test`; fix any real failures.
2. On Windows or GitHub Actions with access to npm, run `cd desktop`, install dependencies, and run `npm run build:win`. Install the resulting `desktop/dist/Sky-First-Mail-Setup-1.0.0.exe` on a supported Windows device and test launch, login, navigation, update and uninstall.
3. Run the Worker against non-production D1/R2 and configured mail-provider credentials to verify real inbound/outbound email, MIME, inline CID images, attachments, retry/idempotency, auth/RBAC and recovery.
4. Only then mark the full release PASS. This source package contains no actual `.exe` and has not been deployed.

## Scope qualification

This release candidate does not finish all 12 agreed feature groups. The implementation audit in `IMPLEMENTATION_AUDIT.md` records which feature groups are partial or need live verification. Do not treat static source checks as proof of end-to-end behavior.
