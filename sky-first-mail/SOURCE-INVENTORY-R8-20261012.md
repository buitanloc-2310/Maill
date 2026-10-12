# Sky First Mail — Source Inventory R8 CLEAN

- **Archive revision:** R8 CLEAN — cập nhật cách tải ảnh/link ngoài khi đọc email, regression tests và tài liệu.
- **Application/package version:** `sky-first-mail` 12.0.4.
- **Canonical root in ZIP:** `Sky-First-Mail/`.
- **Source baseline:** cây R7 CLEAN; giữ nguyên backend/API/D1/R2, không thêm migration hoặc thay đổi production.

## Cấu trúc và số lượng

Gói có một thư mục dự án duy nhất, không chứa ZIP lồng bên trong, không chứa thư mục dự án trùng tên bị lồng, không đóng gói `node_modules`, `.git`, `.env` hoặc `.dev.vars`.

| Khu vực | Số file |
|---|---:|
| `src/` | 11 |
| `public/` | 23 |
| `migrations/` | 8 |
| `tests/` | 3 |
| `scripts/` | 5 |
| `desktop/` | 3 |
| `.github/` | 1 |
| `docs/` | 15 |
| Tài liệu/cấu hình tại root (sau bổ sung R8) | 24 |
| **Tổng không tính `SHA256SUMS.txt`** | **93** |
| `SHA256SUMS.txt` | 1 |
| **Tổng file dự kiến trong ZIP** | **94** |

`SHA256SUMS.txt` liệt kê SHA-256 cho mọi file bên trong trừ chính file checksum, vì tự tham chiếu sẽ không tạo được một checksum ổn định.

## Thành phần chính

- Worker/API: `src/index.js` và các thư viện trong `src/lib/`.
- Webmail: `public/app.js`, `public/v3.js`, `public/v4.js`, `public/v5.js`, CSS và tài nguyên PWA.
- D1 migrations: `migrations/0001_base.sql` đến `0008_transport_domains.sql`.
- Tests: `tests/mail.test.mjs`, `tests/requirements.test.mjs`, `tests/db.mjs`.
- Browser/mobile smoke: `scripts/browser-smoke.cjs`, `scripts/composer-sanitizer-smoke.cjs`, `scripts/mobile-layout-smoke.cjs`.
- Electron: `desktop/main.cjs` và `desktop/package.json`; `desktop/package-lock.json` hiện chưa có.
- CI: `.github/workflows/build-windows.yml`.

## Thay đổi R8 liên quan ảnh/link

- Ảnh ngoài HTTP/HTTPS trong email nhận tự tải; URL trong `srcset` và `background` HTML cũ chỉ giữ khi đạt allowlist an toàn.
- Link HTTP/HTTPS, `mailto:` và `tel:` an toàn mở riêng với `noopener noreferrer nofollow`.
- `javascript:`, `vbscript:`, script, event handlers và nội dung HTML chủ động vẫn bị loại; CSS `url()`/`@import` tiếp tục bị lọc.
- Chính sách ảnh ngoài tự tải có rủi ro quyền riêng tư vì máy chủ ảnh có thể ghi nhận request; khung đọc thư đặt `no-referrer`.

## Kiểm thử R8

| Kiểm tra | Trạng thái |
|---|---|
| `npm run validate` | PASS |
| `npm run test:requirements` | PASS — 62/62 |
| `npm run test:composer-sanitizer` | PASS — Chromium thật; ảnh/link HTTP/HTTPS được giữ và nội dung nguy hiểm bị loại |
| `npm run test:mobile` | PASS |
| `npm test` | BLOCKED — `postal-mime` chưa được cài |
| `npm run test:browser` | BLOCKED — môi trường chặn `127.0.0.1` trong E2E; sanitizer con đã PASS |
| Email thật giữa nhà cung cấp | NOT RUN |
| Build Windows `.exe` và production | NOT RUN |

## Xác minh archive cuối

- Đã giải nén chính ZIP R8 vào thư mục sạch và chạy lại validate, requirements, Chromium sanitizer và mobile smoke từ nội dung giải nén.
- 94 file, một root duy nhất; 93 checksum được xác minh không có mismatch.
- `npm test` vẫn BLOCKED vì thiếu `postal-mime`; browser E2E vẫn BLOCKED do chính sách môi trường chặn `127.0.0.1`.

## Trạng thái nghiệm thu

R8 đã sửa và kiểm thử được chính sách hiển thị ảnh/link trong mã nguồn frontend. Chưa kết luận integration test email, email thật giữa các nhà cung cấp, build Windows hoặc production đạt. Không deploy và không thay đổi dữ liệu production.
