# Sky First Mail — R5 remediation and verification report

Date: 2026-10-12  
Scope: source tree `Maill-main/sky-first-mail` in the supplied ZIP. The nested legacy `sky-first-mail/sky-first-mail/` snapshot is preserved and was not merged into active source. No production deployment, remote D1 migration, live email send, or production data change was performed.

## Changes made in R5

### Mail Studio HTML/XSS containment

- Added a centralized allowlist-based `sanitizeComposerHtml()` in `public/v5.js`.
- The sanitizer removes active tags and form controls, event-handler attributes, `srcdoc`, unsafe URL schemes, SVG/MathML active content, `srcset`, and attributes not explicitly allowed.
- CSS is reduced to a small presentation-property allowlist. CSS `url()`, `expression()`, imports, JavaScript/VBScript values, behavior/binding and escaped-backslash patterns are rejected.
- Link URLs are restricted to HTTP(S), mailto, tel, and same-document anchors. Safe links receive `target="_blank"` and `rel="noopener noreferrer"`.
- Sanitization is applied to initial/reply/forward HTML, clipboard paste, imported/dropped HTML files, template loading, signature insertion, visual/editor synchronization, preview `srcdoc`, draft-save payloads and send payloads.
- Preview iframe `srcdoc` now has a restrictive CSP (`default-src 'none'`, limited image/style/font sources, no base URI/forms).
- Exposed the same sanitizer through `window.SkyFirstSanitizeHtml` for the legacy `public/v7.js` inline-image import path. That path refuses to insert HTML if the sanitizer is unavailable.
- Adjusted the full UI browser smoke URL to use the local loopback address rather than the reserved `.invalid` host.
- Replaced plain-text extraction through a detached `div.innerHTML` with an inert `<template>` fragment; active elements are removed before reading text, reducing unnecessary parsing side effects while composer HTML is being counted or converted to text.

### Regression coverage

- Added `scripts/composer-sanitizer-smoke.cjs`, which extracts and executes the actual production sanitizer inside Chromium on `about:blank`, without navigating to or requesting an external/local URL.
- Added `npm run test:composer-sanitizer`; `npm run test:browser` runs this check before the full frontend/mock-API browser smoke.
- Added regression assertions for the main HTML import, editor, preview, signature, draft/send and legacy V7 paths.
- Updated the release README to document the standalone sanitizer smoke.

## Results actually observed in this environment

| Command/check | Result | Evidence / limitation |
|---|---|---|
| `npm run validate` | PASS | Node syntax checks pass for server modules, front-end scripts, desktop main and test scripts. |
| `npm run test:requirements` | PASS, 60/60 | All 60 requirement/regression assertions passed, including all eight SQLite migrations and the 23-table schema/foreign-key check. |
| `npm run test:composer-sanitizer` | PASS | Actual Chromium DOMParser run rejects script/iframe/SVG content, event handlers, unsafe URLs and dangerous CSS while preserving ordinary formatting, links and table content. All five built-in HTML templates also passed content-preservation and active-tag checks. |
| `npm run test:browser` | BLOCKED after sanitizer passes | Chromium policy blocks `http://127.0.0.1` with “Your organization doesn’t allow you to view this site”. Full UI flow and mobile overflow were not executed in this environment. The test remains fail-closed. |
| `npm test` | BLOCKED before suite execution | `postal-mime` is missing/incomplete in local `node_modules`. npm registry requests fail with DNS `EAI_AGAIN`; the integrated MIME/mail tests were not executed. |
| `npm ci` | BLOCKED | Retried installation; npm logs confirm registry DNS failures. No dependency was substituted or mocked to fake a pass. |
| Live cross-provider email | NOT RUN | No test provider credentials/controlled inbox were supplied for an authorized real send/receive cycle. |
| Windows `.exe` build | NOT RUN | No Windows runner result/artifact is available in this session; desktop dependencies could not be installed here. `desktop/package-lock.json` is still absent, so desktop dependency resolution is not fully reproducible. |
| Production verification/deployment | NOT RUN | No production deployment, remote migration, or data mutation was attempted. |

## Remaining gates (not claimed complete)

1. On a network-enabled runner, install from the committed lock file and run `npm test`.
2. Run `npm run test:browser` on a browser runner that permits loopback navigation and retain the report/screenshots.
3. Perform one explicitly authorized send/receive cycle between a controlled external provider and Sky First Mail; keep secrets/cookies out of logs.
4. Build and test the Windows installer on `windows-latest`; add and commit a desktop lockfile after dependency resolution is possible.
5. Complete staging/prod smoke checks only with operator approval; do not treat static checks as production certification.

## Release status

R5 addresses the HTML insertion/XSS path found in the previous review, hardens text extraction, and adds a real-Chromium sanitizer check. The five built-in templates retain their text in the sanitizer check. Static/requirements checks pass. Integrated email tests, full UI E2E, cross-provider delivery, Windows installer and production remain unverified or blocked; R5 is not represented as a fully certified production release.
