# Sky First Mail — Scaling Architecture

## Current production foundation

- **Cloudflare Worker**: HTTP API + Email Routing inbound handler.
- **R2**: raw `.eml`, attachments, avatars and future large objects.
- **D1**: authentication, users, mailbox metadata, message index, rules, audit logs and settings.
- **Resend**: outbound Internet email.

The key rule is: **large binary/mail content must not be stored in D1**. D1 is an index, not the mailbox object store.

## 100 GB+ storage

R2 is the storage layer. Growing to 100 GB of message/object data does not require putting 100 GB into D1. Message rows only keep metadata and an R2 object key.

Recommended additions before high volume:

1. Lifecycle/retention policy for Trash/Spam.
2. Per-account quota counters.
3. Async indexing pipeline for search.
4. Queue-based outbound and inbound post-processing.
5. R2 object naming by tenant/user/date for operational clarity.

## 1,000,000 accounts

A single D1 database is **not** the intended final metadata topology for one million accounts. The application should keep the same API/storage contracts and replace or shard the metadata layer:

- D1 sharding by tenant/account range, or
- PostgreSQL-compatible database behind Hyperdrive, or
- another distributed metadata/index database.

R2 objects do not need to move when the metadata database is changed; only object keys and indexes migrate.

## Suggested evolution

### Stage A — current / small deployment
Single Worker + single D1 + single R2 bucket + Resend.

### Stage B — growing deployment
Worker + Queues + R2 + D1 split (identity/core vs mail indexes) + analytics/cache.

### Stage C — large deployment
API gateway Worker + service Workers + Queues + R2 + sharded/external metadata database + dedicated search index + observability.

This repository implements Stage A with a Stage B-compatible storage split.
