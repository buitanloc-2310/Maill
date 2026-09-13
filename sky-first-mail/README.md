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
