# Sky First Mail R6 — Mobile Webmail & UI Hardening Report

**Date:** 2026-10-12  
**Base:** Sky First Mail R5 source ZIP  
**Version:** `12.0.3`

## Summary

R6 focuses on directly improving the webmail UI that can be changed and tested locally, especially phone-sized screens, and on adding a repeatable, network-free Chromium smoke test. The existing Worker/API/D1/R2 design and the older nested source snapshot were preserved. No production resources were accessed or modified.

## Changes made

### Responsive navigation

- On narrow screens, keep four primary folders directly available: Inbox, Starred, Sent, Drafts.
- Add a clearly labeled “Thêm” menu for Snoozed, Archive, Spam, Trash, Contacts, Admin and Account/Settings instead of requiring users to discover secondary destinations by horizontal swiping.
- Keep the More control active while a secondary folder is selected.
- Add visible short labels on narrow-phone navigation: “Thư đến”, “Sao”, “Đã gửi”, “Nháp”, “Soạn”, and “Thêm”.
- Add accessible names, keyboard activation, and labels/titles to key navigation, search, reload, notification, and account controls.

### Reader and layout

- Constrain the reader and message rows to the viewport, contain horizontal scrolling in the correct toolbar areas, and avoid overlapping the bottom mobile navigation.
- Add responsive handling for forms, contacts/admin modals, account settings, statistics, tabs, and the composer.
- Add safe-area padding for mobile devices and reduce motion when the operating system requests reduced motion.
- The actual Chromium smoke sweeps portrait and landscape viewports and detects document/body horizontal overflow.

### Mail Studio composer

- Make recipient controls, advanced options, subject, format tabs, editor toolbar, editing surface, attachments and action buttons fit phone widths.
- Prevent the action footer from covering the editor while scrolling.
- Change in-composer feedback to an in-flow accessible status region (`role="status"`, `aria-live="polite"`) so transient “sent/draft” notices do not cover Save/Send buttons. Other toasts replace older ones rather than accumulating.
- Add network-free checks for the Save Draft action and the Send Test code path through the isolated mock API. The smoke test explicitly verifies that no real email is sent.

### Test and build integration

- Add `npm run test:mobile`, a network-free smoke harness that runs the actual `public/styles.css`, `public/app.js`, `public/v3.js`, `public/v4.js`, and `public/v5.js` in Chromium `about:blank` with an in-memory API mock.
- Add the mobile smoke to GitHub Actions and upload screenshots/JSON evidence as an artifact.
- Bump root package version and matching root lockfile metadata to `12.0.3`.

## Evidence and test results

| Command / check | Result | Scope / limitations |
|---|---|---|
| `npm run validate` | **PASS** | Node syntax checks for the listed application, desktop and test scripts. |
| `npm run test:requirements` | **62/62 PASS** | Source/contract assertions, SQLite in-memory migration and regression checks in this suite. |
| `npm run test:composer-sanitizer` | **PASS** | Real Chromium `DOMParser`; active markup, event handlers, unsafe URLs/SVG data, unsafe CSS, safe links, formatting/text retention, and five built-in templates. |
| `npm run test:mobile` | **PASS** | Real Chromium + actual frontend scripts/CSS, isolated mock API, no production/local server/network calls and no real email sent. No JS errors. |
| Main layout sweep | **PASS** | 320×740, 360×800, 390×844, 430×932, 768×1024, 844×390, 932×430, 1440×1000; no document/body horizontal overflow. |
| Composer sweep | **PASS** | 320×740, 360×800, 390×844, 430×932, 844×390 (landscape); composer bounds and To/Cc/Bcc/editor/attachment/send control presence verified. |
| More menu / secondary folder | **PASS** | Snoozed folder navigates via the new menu and the corresponding API mock is called. |
| Read message | **PASS** | Reader area does not overlap the mobile navigation. |
| Save draft / Send Test UI action | **PASS (mock only)** | One mock draft save and one mock compose request to the account's own address; external-network indicator false. No real email sent. |
| Mobile navigation labels / compose feedback | **PASS** | Short labels are visible at 320–430 px; send-test status is an accessible in-flow message rather than a toast overlaying the action buttons. |
| `npm test` | **BLOCKED** | Fails before suite execution because `postal-mime` is absent (`ERR_MODULE_NOT_FOUND`). npm registry resolution previously failed with `EAI_AGAIN`; no mock parser was substituted. |
| `npm run test:browser` | **BLOCKED** | The sanitizer subtest passes, but the full browser smoke cannot open the local test origin because Chromium policy blocks `127.0.0.1` (`URLBlocklist`). |
| Cross-provider live email | **NOT RUN** | Requires authorized test mailboxes/provider configuration; this local mock does not prove delivery. |
| Windows installer / production | **NOT RUN** | No successful GitHub Actions artifact or real `.exe` installation evidence in this environment. Production was not accessed. |

## Artifacts

`npm run test:mobile` writes the JSON report and screenshots under `TEST_ARTIFACT_DIR` (or the system temp directory by default). The final R6 evidence report and screenshots are also included under `docs/mobile-r6-evidence/`. Screenshots are evidence of the local mocked UI state, not live production screenshots.

## Remaining limitations

1. Full email integration tests require restoring the real `postal-mime` dependency from the lockfile in an environment with registry access.
2. Full browser E2E requires an allowed local test origin or execution in GitHub-hosted CI. R6's network-free mobile smoke is a separate, successfully run test; it does not replace the full browser suite.
3. Real two-way email tests with Gmail/Outlook/Proton/Yahoo/Fastmail have not been executed.
4. No Windows `.exe` artifact has been built and installed here. `desktop/package-lock.json` is still absent, so deterministic desktop dependency locking remains an outstanding release item.
5. These are Chromium emulated viewport tests, not physical iOS/Android device tests or a full Safari/Firefox matrix.
6. Production data/configuration was not changed. R6 is not a claim that every webmail function is fully accepted or free of all defects.

## Release decision

**R6: mobile webmail improvements implemented and the locally runnable responsive/sanitizer suites pass. Overall system acceptance: NOT COMPLETE.** The blocked integration and full E2E suites, live provider tests, and Windows release test must be completed before claiming end-to-end acceptance.

## Fresh-archive verification (after packaging)

The delivered ZIP was extracted to a clean directory and the following commands were run from the extracted project, not only from the working tree:

- `npm run validate`: **PASS**.
- `npm run test:requirements`: **62/62 PASS**.
- `npm run test:composer-sanitizer`: **PASS**.
- `npm run test:mobile`: **PASS**, including orientation-sized viewports, visible primary-navigation labels, menu navigation, reader geometry, mocked draft save and mocked send-test status.
- `npm test`: **BLOCKED** at module loading with `ERR_MODULE_NOT_FOUND` for `postal-mime`; no test from `tests/mail.test.mjs` actually ran.
- `npm run test:browser`: sanitizer phase **PASS**, then full browser smoke **BLOCKED** when Chromium policy blocked `127.0.0.1`.

No request reached production, and the mocked composer request was handled in-memory; no live email was sent.
