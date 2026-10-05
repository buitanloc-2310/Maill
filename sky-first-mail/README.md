# Sky First Mail 11.0

Đọc UPGRADE-11.md và docs/OPERATIONS-11.md trước triển khai. Bản giao giữ cấu hình Worker/D1/R2 gốc, không thay ID tài nguyên và không chứa secret thật. Chỉ thư mục này là nguồn triển khai; bản cũ lồng sky-first-mail/sky-first-mail đã được loại khỏi ZIP để tránh deploy nhầm.

## Chạy thử local

Node.js 24+:

```sh
npm ci
npm run dev:local
```

Mở http://localhost:8790/#setup=local-mail-setup. Tạo tài khoản `admin@skyfirst.io.vn` cùng mật khẩu tự chọn (ít nhất 10 ký tự). Có thể gửi thư nội bộ cho chính mình. Local chỉ dùng bộ nhớ, mất dữ liệu khi dừng, không gửi ra Resend và không dùng D1/R2 thật. Không dùng máy chủ local cho production.

## Kiểm thử

```sh
npm run validate
npm test
npm run build:check
```

Kiểm thử trình duyệt tùy chọn: cài Playwright, tải Chromium rồi chạy `node scripts/browser-smoke.cjs` từ thư mục này. Có thể đặt CHROMIUM_PATH nếu đã có Chrome tương thích. Script tự mở localhost, tạo tài khoản thử, soạn/lưu nháp/gửi/đọc nội bộ, kiểm tra lỗi JS và viewport điện thoại. Không chạy thêm máy chủ trên cổng 8790 cùng lúc. Ảnh bàn giao nằm trong docs/screenshots.

## Cập nhật hệ thống đã chạy

Sao lưu D1 và toàn bộ R2 trước. Cài bằng npm ci. Chạy migration 0007_reliability.sql theo lịch sử migration hiện có; nếu database từng tạo schema tự động, không áp mù các migration cũ có ALTER TABLE. 0007 chỉ tạo bảng/index IF NOT EXISTS; Worker cũng tự tạo bảng mới để tương thích dữ liệu cũ. Chạy build kiểm tra, triển khai staging rồi production bằng npm run deploy. Xác nhận domain gửi được bật chủ động và RESEND_API_KEY tồn tại. Giữ nodejs_compat để dependency parser chạy đúng.

## Thiết lập database hoàn toàn mới

Đặt SETUP_SECRET ngẫu nhiên qua `npx wrangler secret put SETUP_SECRET`. Sau deploy, mở URL Mail với fragment `#setup=MA_THIET_LAP` (mã phải được URL-encode nếu chứa ký tự đặc biệt). Script giữ mã trong sessionStorage và xóa fragment khỏi thanh địa chỉ; form giao diện không thay đổi. Sau khi thiết lập xong, xóa SETUP_SECRET. Không chia sẻ link này. Tài khoản đã tồn tại không cần thiết lập lại.

Tạo và cấu hình Email Routing, domain xác minh Resend, DNS và quyền D1/R2 trong đúng tài khoản. Có RESEND_API_KEY không tự bật mọi tên miền gửi.
