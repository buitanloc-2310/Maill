# Sky First Mail V12 — Provider-independent Mail Core

V12 removes the hard architectural dependency between the application and a single outbound provider.

## Implemented in source
- Reliable compose path is now the active `/api/compose` implementation: idempotency reservation, MIME persisted to R2 before external delivery, duplicate-send protection, uncertain-delivery state, atomic local delivery.
- Reliability tables are included in runtime schema as well as migration 0007.
- Domain outbound state is explicit. A global Resend key no longer silently enables every managed domain.
- Per-domain transport selection: `resend` or `gateway`.
- `gateway` is the future Sky First MTA/SMTP bridge. Configure `MTA_GATEWAY_URL` and secret `MTA_GATEWAY_TOKEN`; application code does not need to change when moving a domain away from Resend.
- Domain ownership verification uses a generated TXT record `_skyfirst-mail.<domain>` and DNS-over-HTTPS health checks.
- New admin APIs: `POST /api/admin/domains/:id/verify`, `GET /api/admin/domains/:id/health`; domain PATCH supports `transport` and refuses enabling outbound before verification.
- Migration `0008_transport_domains.sql` adds transport, verification, health and inbound-adapter metadata.

## Multi-account Cloudflare model
Each domain may remain in a different Cloudflare account. Its account owns its Email Routing configuration/inbound adapter. All adapters can feed the same Sky First Mail application contract. Outbound is selected per domain and is not coupled to the inbound Cloudflare account.

## Required deployment configuration
Existing Resend mode: `RESEND_API_KEY` secret. Gateway/MTA mode: `MTA_GATEWAY_URL` variable and `MTA_GATEWAY_TOKEN` secret. Do not store secrets in D1 or source.

## External verification still required
Actual Cloudflare Email Routing across separate accounts, production DNS propagation, production D1/R2, Resend delivery and a real MTA gateway cannot be proven from this offline package. These are NOT VERIFIED until deployment tests are run.
