# Sky First Mail — FINAL

Một repository, hai Worker độc lập. Không deploy chéo hai thư mục.

## Cấu trúc

- `web/` — Webmail tại `email.skyfirst.io.vn`, Worker name: `sky-first-mail`
- `inbound-worker/` — Email Routing receiver, Worker name: `sky-first-mail-inbound`

Cả hai dùng chung:
- D1 binding `DB` → database `sky-first-mail`
- R2 binding `MAIL_STORAGE` → bucket `sky-first-mail-storage`

## Cloudflare + GitHub

Nếu repo GitHub của bạn chứa thư mục ngoài cùng `sky-first-mail/`, cấu hình như sau.

### Web Worker `sky-first-mail`
- Repository: repo GitHub hiện tại
- Root directory: `sky-first-mail/web`
- Build command: để trống
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

### Inbound Worker `sky-first-mail-inbound`
- Repository: cùng repo GitHub
- Root directory: `sky-first-mail/inbound-worker`
- Build command: để trống
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

**Không** đặt Root directory của Worker inbound thành `sky-first-mail` hoặc `sky-first-mail/web`.
**Không** đặt Root directory của Web Worker thành `sky-first-mail/inbound-worker`.

## Migrations

Chạy migrations từ thư mục `web/`:

```bash
npm install
npm run db:migrate
```

Nếu D1 hiện đã có `0001_base.sql` từ quá trình cấu hình thủ công trước đó, Wrangler migration sẽ dùng bảng migration riêng. Hãy sao lưu D1 trước khi chạy trên dữ liệu thật.

## Custom domain

Gắn `email.skyfirst.io.vn` vào Worker `sky-first-mail`, không gắn vào `sky-first-mail-inbound`.

Email Routing Catch-all tiếp tục trỏ đến `sky-first-mail-inbound`.

## Kiểm tra nhanh

Web:
```bash
cd web
npm install
npm run validate
```

Inbound:
```bash
cd inbound-worker
npm install
npm run validate
```
