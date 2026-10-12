# Source Layout Audit — Sky First Mail R8 CLEAN

Date: 2026-10-12

## Canonical project root

Dự án hoạt động trong một cây nguồn duy nhất ở thư mục `Sky-First-Mail/`, nơi có `package.json`, `package-lock.json`, `wrangler.jsonc`, `src/`, `public/`, `migrations/`, `tests/`, `scripts/` và `desktop/`.

## Archive cleanliness

- Không có ZIP cũ lồng bên trong gói phát hành.
- Không có thư mục dự án cũ trùng tên bị lồng bên trong.
- Không có `node_modules`, `.git`, `.env` hoặc `.dev.vars` trong bản phát hành.
- Snapshot cũ từ các ZIP trước được giữ bên ngoài gói này, không bị hợp nhất vào cây nguồn R8.

## Source and release status

Package version: `12.0.4`. Bản R8 cập nhật chính sách ảnh/link trong email nhận và bài kiểm thử tương ứng. Cấu hình backend, API, D1/R2 và migrations không thay đổi trong bản vá này.

`npm run validate`, `npm run test:requirements` (62/62), `npm run test:composer-sanitizer` và `npm run test:mobile` đã PASS. `npm test` BLOCKED do thiếu `postal-mime`. Browser E2E BLOCKED bởi chính sách chặn `127.0.0.1`. Email thật, build Windows và production chưa chạy.
