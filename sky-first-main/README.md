# Sky First Mail (V13 Enterprise) — `mail.skyfirst.io.vn`

Hệ thống thư điện tử chuyên nghiệp của **Sky First** vận hành trên một **Cloudflare Worker** kết hợp **Cloudflare D1**, **Cloudflare R2**, **Cloudflare Email Routing** và **Resend / MTA Gateway**.

- **Tên dự án:** Sky First Mail
- **Tên miền chính thức:** `mail.skyfirst.io.vn`
- **Tổng số tệp bàn giao:** **36 tệp** (đạt chuẩn giới hạn $\le 39$ tệp, giữ nguyên 100% migration, bảo mật và kiểm thử tự động).
- **Chính sách AI:** Đã loại bỏ hoàn toàn mọi thành phần/API AI theo Phụ lục Điều chỉnh Bắt buộc; toàn bộ tìm kiếm nâng cao, lọc thư, chống spam, phát hiện rủi ro và chống giả mạo hoạt động bằng thuật toán quy tắc tất định tại máy chủ.

---

## 1. Hướng dẫn Triển khai (Deployment Guide)

### 1.1. Yêu cầu môi trường
- Node.js 18+ hoặc 22+ và Wrangler CLI (`^4.35.0`).
- Tài khoản Cloudflare đã kích hoạt Workers, D1 (`sky-first-mail`), R2 (`sky-first-mail-storage`) và Email Routing cho `skyfirst.io.vn`.

### 1.2. Các biến môi trường và Secret cần cấu hình
Thiết lập bằng lệnh `npx wrangler secret put <TEN_BIEN>` (không bao giờ lưu khóa thật vào mã nguồn):

| Tên biến / Binding | Phân loại | Bắt buộc | Mục đích sử dụng |
| :--- | :--- | :--- | :--- |
| `DB` | D1 Binding | Có | Cơ sở dữ liệu chính (`sky-first-mail`, cấu hình trong `wrangler.jsonc`) |
| `MAIL_STORAGE` | R2 Binding | Có | Lưu trữ MIME gốc của email, tệp đính kèm và ảnh đại diện (`sky-first-mail-storage`) |
| `ASSETS` | Assets Binding | Có | Phục vụ giao diện tĩnh PWA từ `./public` |
| `SETUP_SECRET` | Secret | Có | Khóa khởi tạo tài khoản Siêu quản trị viên lần đầu (độ dài tối thiểu 24 ký tự) |
| `RESEND_API_KEY` | Secret | Có (khi gửi ra ngoài qua Resend) | Khóa API gửi thư ra ngoài hệ thống qua Resend |
| `RESEND_WEBHOOK_SECRET` | Secret | Khuyến nghị | Khóa xác thực chữ ký HMAC cho webhook trạng thái gửi/bounce/spam tại `/api/webhooks/resend` |
| `MTA_GATEWAY_URL` | Variable/Secret | Tùy chọn | URL máy chủ gửi thư thay thế khi dùng transport `gateway` |
| `MTA_GATEWAY_TOKEN` | Secret | Tùy chọn | Khóa xác thực Bearer cho `gateway` |

### 1.3. Các lệnh kiểm thử, migrate và triển khai
```bash
# 1. Kiểm tra cú pháp toàn bộ mã nguồn
npm run validate

# 2. Chạy bộ kiểm thử tích hợp API & cơ sở dữ liệu
npm test

# 3. Chạy bộ kiểm thử yêu cầu kiến trúc, bảo mật & giới hạn tệp (<= 39 tệp)
npm run test:requirements

# 4. Áp dụng migration lên D1 (chỉ chạy khi triển khai/cập nhật DB thật)
npm run db:migrate

# 5. Triển khai Worker lên Cloudflare
npm run deploy
```

---

## 2. Thiết lập DNS, Xác thực Email & BIMI/VMC (Tích xanh bên ngoài)

Để tối ưu khả năng vào hộp thư chính và hiển thị logo thương hiệu / tích xanh trên các nền tảng bên ngoài (Gmail, Yahoo, Apple Mail):

| Loại bản ghi | Tên bản ghi (Host) | Giá trị cấu hình mẫu | Mục đích |
| :--- | :--- | :--- | :--- |
| `CNAME` / `A` | `mail.skyfirst.io.vn` | Trỏ về Worker `sky-first-mail-inbound` (Custom Domain trên Cloudflare) | Tên miền truy cập chính thức của Sky First Mail |
| `MX` | `skyfirst.io.vn` | Các máy chủ MX của Cloudflare Email Routing | Tiếp nhận email gửi đến `@skyfirst.io.vn` |
| `TXT` | `_skyfirst-mail.skyfirst.io.vn` | `skyfirst-mail-verification=<TOKEN_TRONG_ADMIN>` | Xác minh quyền sở hữu tên miền trong Admin |
| `TXT` (SPF) | `skyfirst.io.vn` | `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all` | Xác thực máy chủ được phép gửi thư |
| `TXT` / `CNAME` (DKIM) | `resend._domainkey.skyfirst.io.vn` | Khóa công khai DKIM do Resend cung cấp | Ký số xác thực tính toàn vẹn email gửi đi |
| `TXT` (DMARC) | `_dmarc.skyfirst.io.vn` | `v=DMARC1; p=quarantine; pct=100; adkim=r; aspf=r; rua=mailto:postmaster@skyfirst.io.vn` | Chính sách chống giả mạo (bắt buộc `p=quarantine` hoặc `p=reject` với `pct=100` để đủ điều kiện BIMI) |
| `TXT` (BIMI) | `default._bimi.skyfirst.io.vn` | `v=BIMI1; l=https://mail.skyfirst.io.vn/bimi-logo.svg; a=<URL_CHUNG_THU_VMC_NEU_CO>` | Khai báo logo chuẩn SVG Tiny 1.2 PS (`/bimi-logo.svg`) và chứng thư VMC |

**Lưu ý trung thực về tích xanh trên Gmail:**
- **Tích xanh nội bộ Sky First Mail:** Do Quản trị viên cấp/đình chỉ/thu hồi trực tiếp tại **Trung tâm quản trị > Tích xanh**, kiểm tra quyền tại máy chủ và hiển thị nhất quán trong toàn hệ thống Sky First Mail.
- **Tích xanh bên ngoài trên Gmail:** Google chỉ hiển thị dấu tích xanh khi tên miền đạt chuẩn SPF + DKIM + DMARC (`p=quarantine` hoặc `p=reject`, `pct=100`) + logo BIMI SVG Tiny PS **kèm theo chứng thư số VMC/CMC hợp lệ** do Tổ chức chứng thực quốc tế (DigiCert hoặc Entrust) cấp cho nhãn hiệu đã đăng ký. Chủ sở hữu cần đăng ký chứng thư VMC và điền URL tệp `.pem` vào tham số `a=` của bản ghi `default._bimi`.

---

## 3. Hướng dẫn Khôi phục khi Triển khai Thất bại (Rollback & Recovery)

1. **Khôi phục phiên bản Worker:** Chạy `npx wrangler deployments list` để xem lịch sử các bản phát hành và chạy `npx wrangler rollback` để quay về phiên bản Worker ổn định liền trước ngay lập tức.
2. **Bảo toàn dữ liệu D1 & R2:** Toàn bộ các tệp migration (`0001` đến `0009`) và cơ chế `ensureSchema()` chỉ sử dụng lệnh bổ sung không phá hủy (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN`). Không có lệnh `DROP TABLE` hay xóa lịch sử email.
3. **Sao lưu cấu hình quản trị:** Trong **Trung tâm quản trị > Hệ thống & Bảo mật**, nhấn **Xuất bản sao lưu cấu hình JSON** (`/api/admin/backup`) trước mỗi đợt thay đổi lớn để lưu trữ danh mục tên miền, ủy quyền gửi thay, danh sách chặn và lịch sử xác minh.

---

## 4. Bảng Kiểm kê 36 Tệp Bàn giao ($\le 39$ tệp)

| STT | Đường dẫn tệp | Nhóm | Mục đích |
| :--- | :--- | :--- | :--- |
| 1 | `package.json` | Cấu hình | Khai báo phụ thuộc, phiên bản và các script kiểm thử/triển khai |
| 2 | `package-lock.json` | Cấu hình | Khóa phiên bản cây phụ thuộc npm |
| 3 | `wrangler.jsonc` | Cấu hình | Cấu hình Cloudflare Worker, D1 (`DB`), R2 (`MAIL_STORAGE`), Assets |
| 4 | `README.md` | Tài liệu | Tài liệu triển khai, biến môi trường, DNS/BIMI, khôi phục và kiểm kê tệp |
| 5 | `migrations/0001_base.sql` | Migration D1 | Khởi tạo bảng cơ sở: `users`, `mailboxes`, `messages`, `attachments`, `sessions`, `settings`, `audit_logs` |
| 6 | `migrations/0002_accounts.sql` | Migration D1 | Mở rộng hồ sơ tài khoản, `login_history`, `aliases`, `user_preferences` |
| 7 | `migrations/0003_workspace.sql` | Migration D1 | Mở rộng workspace: `contacts`, `signatures`, `labels`, `message_labels`, `mail_rules`, `notifications`, `managed_domains` |
| 8 | `migrations/0004_v4_productivity.sql` | Migration D1 | Bảng lưu nháp `compose_drafts` |
| 9 | `migrations/0005_v5_mail_studio.sql` | Migration D1 | Mở rộng HTML Mail Studio: `mail_templates`, `delivery_events` |
| 10 | `migrations/0006_multidomain.sql` | Migration D1 | Khởi tạo hỗ trợ đa tên miền |
| 11 | `migrations/0007_reliability.sql` | Migration D1 | Bảng chống gửi trùng và giới hạn đăng nhập: `send_operations`, `login_limits`, `inbound_receipts` |
| 12 | `migrations/0008_transport_domains.sql` | Migration D1 | Siêu dữ liệu transport và xác minh tên miền |
| 13 | `migrations/0009_v13_governance.sql` | Migration D1 | Nâng cấp V13: `verification_history`, `send_delegations`, `send_queue`, `message_recalls`, `suppression_list`, `security_alerts` và các cột xác minh/BIMI/thu hồi |
| 14 | `src/index.js` | Backend Worker | Điểm khởi chạy Worker, định tuyến API, quản trị V13 và xử lý nhận thư `email()` |
| 15 | `src/lib/auth.js` | Backend Lib | Quản lý phiên đăng nhập, kiểm tra quyền/thời hạn tài khoản và phản hồi HTTP JSON |
| 16 | `src/lib/compose.js` | Backend Lib | Xử lý soạn/gửi thư, kiểm tra quyền gửi thay, giữ hoàn tác (`Undo Send`), kiểm soát rủi ro và lưu trữ R2 |
| 17 | `src/lib/content-policy.js` | Backend Lib | Kiểm tra chữ ký byte ảnh đại diện, tải tệp đính kèm an toàn và chặn phần mở rộng thực thi độc hại |
| 18 | `src/lib/governance.js` | Backend Lib | Xác minh tích xanh, kiểm tra DNS SPF/DKIM/DMARC/BIMI, thu hồi email, chống spam/rủi ro, danh sách chặn và báo cáo uy tín |
| 19 | `src/lib/mail.js` | Backend Lib | Bộ làm sạch HTML email (`cleanEmailHtml`), đóng gói MIME (`buildMime`) và phân tích MIME (`parseStoredMessage`) |
| 20 | `src/lib/security.js` | Backend Lib | Băm mật khẩu PBKDF2, chữ ký HMAC-SHA256, giới hạn luồng dữ liệu (`boundedRequest`, `readStreamBounded`) |
| 21 | `src/lib/transport.js` | Backend Lib | Kết nối gửi thư ra ngoài qua Resend API và MTA Gateway |
| 22 | `public/index.html` | Giao diện | Trang khởi chạy ứng dụng Webmail |
| 23 | `public/styles.css` | Giao diện | Toàn bộ hệ thống giao diện, responsive mobile, Admin Center và huy hiệu tích xanh/BIMI/thu hồi |
| 24 | `public/app.js` | Giao diện | Ứng dụng Webmail chính, đọc thư, thu hồi thư, cài đặt hồ sơ và Trung tâm Quản trị V13 |
| 25 | `public/v5.js` | Giao diện | Trình soạn thảo HTML Mail Studio, chọn danh tính gửi thay, phân loại thư và thanh Hoàn tác gửi |
| 26 | `public/sw.js` | Giao diện | Service Worker lưu đệm tài nguyên tĩnh (không lưu đệm API/dữ liệu thư) |
| 27 | `public/manifest.webmanifest` | Giao diện | Cấu hình PWA cho máy tính và thiết bị di động |
| 28 | `public/library/compose-library.json` | Giao diện | Thư viện 5 mẫu email HTML chuyên nghiệp và 10 mẫu phản hồi nhanh |
| 29 | `public/bimi-logo.svg` | Tài nguyên | Logo thương hiệu Sky First định dạng SVG Tiny 1.2 PS chuẩn BIMI |
| 30 | `public/sky-first-logo.png` | Tài nguyên | Logo chính thức Sky First (2000x2000 PNG) |
| 31 | `public/favicon-app.png` | Tài nguyên | Biểu tượng trình duyệt (256x256 PNG) |
| 32 | `public/app-icon-192.png` | Tài nguyên | Biểu tượng ứng dụng PWA (192x192 PNG) |
| 33 | `public/app-icon-512.png` | Tài nguyên | Biểu tượng ứng dụng PWA (512x512 PNG) |
| 34 | `scripts/local-server.mjs` | Công cụ | Máy chủ phát triển và kiểm thử cục bộ trên bộ nhớ tạm |
| 35 | `tests/db.mjs` | Kiểm thử | Lớp kết nối cơ sở dữ liệu kiểm thử hỗ trợ cả Node 18 và Node 22+ |
| 36 | `tests/mail.test.mjs` | Kiểm thử | Bộ 26 bài kiểm thử tích hợp API gửi/nhận, bảo mật, tích xanh, hoàn tác, thu hồi, gửi thay và chống spam |
| 37 | `tests/requirements.test.mjs` | Kiểm thử | Bộ kiểm thử cấu trúc, giới hạn $\le 39$ tệp, 9 migration (29 bảng), chuẩn BIMI và không phụ thuộc AI |
