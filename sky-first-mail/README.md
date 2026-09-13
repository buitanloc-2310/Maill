# Sky First Mail — One Worker

Bản này dùng **một Worker duy nhất** cho cả website và Email Routing.

- Worker name: `sky-first-mail-inbound`
- Custom domain: `gmail.skyfirst.io.vn`
- Email Routing catch-all: `sky-first-mail-inbound`
- D1 binding: `DB`
- R2 binding: `MAIL_STORAGE`
- GitHub root directory: `sky-first-mail`
- Deploy command: `npx wrangler deploy`

Worker có cả `fetch()` (web/API) và `email()` (nhận mail), vì vậy không cần tạo Worker web thứ hai.

## Gửi email ra ngoài bằng Resend

Worker hỗ trợ gửi email Internet qua Resend. Thêm Worker Secret `RESEND_API_KEY` vào Cloudflare. Domain gửi phải được Verified trên Resend. Không lưu API key trong GitHub hoặc `wrangler.jsonc`.

Luồng:
- Nhận thư: Cloudflare Email Routing -> Worker -> D1/R2
- Gửi thư ngoài hệ thống: Sky First Mail -> Resend API -> Gmail/Outlook/...
- Gửi nội bộ: xử lý trực tiếp trong D1/R2

## v2 architecture note

This build intentionally stores **large mail data in R2** and keeps **D1 as metadata/index only**. See `docs/SCALING.md` for the path toward 100 GB+ storage and large account counts. A single D1 database should not be treated as a one-million-account architecture.

### New v2 improvements
- Rebuilt profile/avatar experience with preview, upload, deletion and R2-backed cache busting.
- Interactive login/footer information panels.
- Expanded Admin Center with System/Storage architecture view.
- Resend outbound + Cloudflare Email Routing inbound remain in the same Worker.
- More polished responsive Sky First visual system.
