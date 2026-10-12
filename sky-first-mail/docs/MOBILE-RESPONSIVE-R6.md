# Mobile responsive checks — R6

Run from the active `sky-first-mail` root:

```sh
npm run validate
npm run test:requirements
npm run test:composer-sanitizer
npm run test:mobile
```

The mobile smoke test launches Chromium into `about:blank`, injects the real local frontend code and CSS, and uses a deterministic in-memory mock API. It does not use localhost, contact production, or send real email.

It checks viewport sizes 320×740, 360×800, 390×844, 430×932, 768×1024, 844×390, 932×430 and 1440×1000, plus the Mail Studio composer at 320×740, 360×800, 390×844, 430×932 and 844×390 (landscape). It checks horizontal overflow, mobile menu visibility, navigation to a secondary folder, reader/navigation overlap, composer controls, save-draft action and mocked Send Test action.

Set `TEST_ARTIFACT_DIR` to choose where screenshots and `mobile-smoke-report.json` are written. The test's successful mocked Send Test request is not a live email delivery test.

At widths 320–430 px, the bottom navigation also exposes short visual labels for the primary folders and the Compose/More actions. Mail Studio shows sent/draft feedback in an in-flow accessible status instead of covering touch controls with a fixed toast.
