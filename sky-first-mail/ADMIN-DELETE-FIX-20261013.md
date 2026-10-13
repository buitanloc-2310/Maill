# Sky First Mail — Account deletion repair (2026-10-13)

## What changed

- Replaced the fixed list of dependent-delete statements with a schema-driven deletion plan built from the live SQLite/D1 table and foreign-key metadata.
- Traverses owned records reached from `users` through `CASCADE` and `NO ACTION`/`RESTRICT` relationships, and explicitly deletes those dependent rows child-first before the guarded user-row delete.
- Explicitly treats mailbox-owned `messages` as deletable even though the legacy FK uses `ON DELETE SET NULL`.
- Keeps audit history: audit rows configured with `ON DELETE SET NULL` remain and become detached from the deleted user.
- Makes R2 object-key inventory best-effort so a missing optional storage column cannot prevent database deletion. Object cleanup remains fail-closed: an object is not deleted if the reference check cannot establish that it is unused.
- Adds stage and short database detail to an unsuccessful API response, and displays that diagnostic in the in-page admin error message rather than hiding it behind the generic `ADMIN_DELETE_FAILED` label.
- Adds `npm run test:admin-delete`, a Worker API integration test backed by SQLite, including extra non-cascading FKs that simulate production-only tables pointing to users, mailboxes, and messages.

## Local checks run

- `npm run validate` — passed.
- `npm run test:requirements` — 62/62 passed.
- `npm run test:admin` — passed in Chromium using the isolated mock API; no native browser dialogs or frontend JS errors.
- `npm run test:admin-delete` — passed against the Worker API and SQLite, including production-only `NO ACTION` FKs on users, mailboxes and messages; deletion succeeded and audit history was preserved.

## Deployment note

This is a source-code repair and local integration verification. It has not been deployed to the production Cloudflare Worker or run against the live D1 database from this environment. Back up the remote D1 database before deploying. The live result must still be verified after deployment.
