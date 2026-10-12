# Sky First Mail — Live mail and release smoke tests

Use a dedicated test sender and a controlled external test mailbox. Do not use customer email addresses, production user data, or a personal session cookie with broad privileges.

## Live cross-provider send/receive

From the canonical project root, configure these in a local terminal only:

```bash
export MAIL_SMOKE_BASE_URL='https://your-staging-origin'
export MAIL_SMOKE_SESSION_COOKIE='your-short-lived-test-session-cookie'
export MAIL_SMOKE_TO='you-control-this-mailbox@example-provider.test'
export MAIL_SMOKE_CONFIRM_SEND='SEND_ONE_LIVE_TEST_EMAIL'
export MAIL_SMOKE_ALLOW_REMOTE='YES'
# For the configured production hostname only, additionally set after approval:
# export MAIL_SMOKE_ALLOW_PRODUCTION='YES'
node scripts/live-mail-smoke.mjs
```

The script verifies the authenticated session and sender mailbox before sending. It submits one plain text/HTML email with a unique token and no attachment. It then polls the Sky First inbox for a reply from the controlled destination with that token. Open the destination mailbox and reply while the script is waiting. Do not blindly re-run after a timeout: check send operations and provider events first to avoid duplicates.

The test can show that one real outbound submission and one matching inbound reply were observed. It does not by itself verify spam-folder placement, complete header conformance across all providers, provider bounce/webhook processing, or SPF/DKIM/DMARC. Record those separately for Gmail, Outlook/Microsoft 365, Proton, Yahoo, and other required providers.

## Browser smoke

```bash
npm run test:browser
```

This uses Chromium and an isolated mock API; it never calls the real mail backend and never sends email. If the local browser policy blocks URL navigation, do not disable or bypass it. Run the same command in the configured GitHub Actions Ubuntu job, where the browser report and screenshots are uploaded as artifacts.

## Windows installer

The `windows-installer` GitHub Actions job runs only after validation and mock-browser tests pass. Download `sky-first-mail-windows-installer`, verify the EXE against `SHA256SUMS.txt`, and run install/login/link/uninstall checks on a supported Windows device. A CI-built EXE is not the same as a production-deployed or code-signed release.
