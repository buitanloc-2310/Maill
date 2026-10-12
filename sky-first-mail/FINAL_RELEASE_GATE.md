# Sky First Mail — Final Release Gate (R4)

Date: 2026-10-12

## Release decision

**NOT APPROVED FOR FULL RELEASE.** Source validation and the requirement regression suite pass, but the four environment-dependent gates below have not produced live evidence in this session. No production deployment, remote migration, or real outbound email was performed.

## Evidence from this session

| Gate | Command / evidence | Result |
|---|---|---|
| JavaScript syntax | `npm run validate` | PASS — includes source modules, frontend, desktop shell, and both smoke scripts |
| Requirement regression suite | `npm run test:requirements` | PASS — 58 tests, 0 failures |
| Eight D1 migrations | Existing regression test runs migration files in in-memory SQLite | PASS — eight migrations and 23 tables; foreign-key assertions pass |
| Full mail / MIME / API integration suite | `npm test` | BLOCKED before tests start — `postal-mime` is not installed in this environment |
| Dependency recovery | `npm view postal-mime version` | BLOCKED — npm registry DNS returned `EAI_AGAIN` |
| Browser smoke script | `npm run test:browser` | BLOCKED in this container — managed Chromium policy sets `URLBlocklist` to `*`; the browser blocks every navigation, including the isolated test origin. Do not bypass this policy here. |
| Browser CI wiring | `.github/workflows/build-windows.yml` | CONFIGURED — GitHub-hosted Ubuntu job will run the dependency-free Chromium flow with a mock API and upload screenshots/report |
| Real cross-provider email | `scripts/live-mail-smoke.mjs` | NOT RUN — no test-session cookie, test recipient, provider session, or remote connectivity supplied; script defaults to no-send and requires explicit acknowledgements |
| Production access / DNS / delivery | Production origin referenced in `desktop/README.md` | NOT VERIFIED — this environment could not resolve/reach the origin, and no Cloudflare/Resend credentials are available |
| Windows installer | GitHub Actions `windows-installer` job | NOT BUILT IN THIS SESSION — desktop dependencies cannot be downloaded here; CI is configured to build, verify the EXE, calculate SHA-256, and upload both artifacts |
| Deployment / remote D1 migrations | No deploy command run | NOT RUN intentionally |

## The four remaining gates

### 1. Full mail integration tests

On a network-enabled Node 22 runner from the canonical project root:

```bash
npm ci --no-audit --no-fund
npm run validate
npm test
npm run test:requirements
npm run test:browser
```

The package lock pins `postal-mime` to 2.7.6. If `npm ci` fails, preserve the complete npm error log and do not substitute a fake parser.

### 2. Browser / responsive E2E

The browser smoke script uses the real frontend assets with an isolated mock API; it does not connect to production or send real messages. GitHub Actions is now configured to run it on a hosted runner and upload `mail-desktop.png`, `mail-reader.png`, `mail-mobile.png`, and `browser-smoke-report.json`. This is a browser UI test, not a replacement for running the mail API suite.

### 3. Real cross-provider send and receive

`scripts/live-mail-smoke.mjs` is an opt-in manual test. It sends exactly one message only after `MAIL_SMOKE_CONFIRM_SEND=SEND_ONE_LIVE_TEST_EMAIL`, requires a remote endpoint acknowledgement, and requires a separate acknowledgement for the configured production hostname. It then waits for a reply containing a one-time token to appear in the Sky First inbox. It does not log the session cookie. Run it only with an approved staging sender and test mailbox first; a reply confirms a live inbound path, but spam placement, bounce semantics, SPF, DKIM, and DMARC still require separate verification.

Required environment values:

- `MAIL_SMOKE_BASE_URL` — HTTPS origin for the test instance.
- `MAIL_SMOKE_SESSION_COOKIE` — short-lived session cookie from a dedicated test account; never commit or paste it into chat.
- `MAIL_SMOKE_TO` — a controlled mailbox on a different provider/domain.
- `MAIL_SMOKE_CONFIRM_SEND=SEND_ONE_LIVE_TEST_EMAIL` — mandatory explicit send acknowledgement.
- `MAIL_SMOKE_ALLOW_REMOTE=YES` — mandatory for a remote origin.
- `MAIL_SMOKE_ALLOW_PRODUCTION=YES` — additionally required when targeting `gmail.skyfirst.io.vn`.

Start the script, then open the receiving Gmail/Outlook/Proton/other test mailbox and reply to the test message before the configured timeout expires. No credentials or destination are currently configured in this environment, so this test was not run.

### 4. Windows build and production acceptance

GitHub Actions now waits for all validation and browser tests before building the NSIS x64 installer on `windows-latest`. The Windows job checks that the EXE exists, writes its SHA-256 checksum, and uploads both. No workflow execution/artifact was available in this session; therefore no Windows installer is claimed as built or tested.

After obtaining the actual artifact, install it on a supported Windows device, verify the configured origin and login flow, test external links, then uninstall it. For production mail validation, use a controlled test recipient, confirm provider event/delivery status, reply from the external provider, check the inbound copy in Sky First, and review the actual DNS records at authoritative DNS/provider dashboards. Do not perform destructive account or data tests against production.

## Explicit non-claims

- The `58/58` requirement suite does not mean the complete email integration suite passed.
- Mock-browser send success does not mean Resend delivered a real email.
- Ownership TXT verification does not by itself prove SPF, DKIM, DMARC, MX, or inbound routing are correct.
- CI workflow configuration is not proof that a workflow ran or that an EXE artifact exists.
- This revision has not been deployed to production.

## R5 delta review — 2026-10-12

- **Fixed in code:** centralized allowlist HTML sanitizer is applied across Mail Studio HTML entry points and send/draft payloads; preview iframe CSP is more restrictive; legacy V7 HTML insertion uses the sanitizer or refuses the import.
- **PASS:** `npm run validate`; `npm run test:requirements` (60/60); `npm run test:composer-sanitizer` in actual Chromium on `about:blank`.
- **BLOCKED:** full `npm run test:browser` due organizational Chrome URL blocklist for loopback; `npm test` due npm registry `EAI_AGAIN` and unavailable `postal-mime`.
- **NOT RUN:** cross-provider live email, Windows installer artifact, production smoke/deployment.
- Full evidence and remaining gates: `AUDIT-AND-FIX-R5-20261012.md`.
