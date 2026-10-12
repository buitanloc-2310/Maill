# Source layout audit — Sky First Mail

Date: 2026-10-12

## Canonical project root

Use **this directory** (`Maill-main/sky-first-mail/`) as the active project root. Its manifest identifies `sky-first-mail` version `12.0.1`; it contains the current Worker entry point (`src/index.js`), current frontend (`public/`), migrations `0001` through `0008`, the reliability tables, current tests, and the current desktop shell.

Run dependency installation, validation, tests, local development, and deployment commands only from this directory after validating the environment and reviewing the deployment target.

## Preserved nested snapshot

The ZIP also contains `Maill-main/sky-first-mail/sky-first-mail/`. That nested tree identifies itself as version `5.0.0`, has fewer migrations and materially different files. It is preserved as a historical/legacy snapshot because it is not byte-identical to the root source. It must **not** be used as the active deployment root by mistake.

No attempt was made to merge or delete that snapshot during this repair. Reconciliation or removal should be a separately reviewed action after an owner verifies whether it is still needed.

## Operational caution

The ZIP intentionally preserves the duplicate tree to avoid destroying potentially important source history. This introduces an ambiguity for anyone opening the archive. Follow the canonical root described above; compare file/version manifests before any future merge or cleanup.
