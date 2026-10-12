# Kết quả kiểm thử — Mail 11.0

Đã thực hiện tại môi trường cục bộ ngày 05/10/2026:

- npm run validate: cú pháp 12 tệp JavaScript đạt.
- npm test: 16/16 kết quả kiểm thử Node đạt (bao gồm nhóm API và các ca con). SQLite thật trong bộ nhớ; R2/provider được mô phỏng. Không gửi email thật.
- wrangler deploy --dry-run: build Worker thành công; nhận đúng binding DB/MAIL_STORAGE/ASSETS. Không deploy lên tài khoản.
- Chromium headless + Playwright: thiết lập với secret → mở hộp thư → soạn HTML → lưu nháp → gửi nội bộ cho chính mình → mở đọc thư. Không ghi nhận pageerror trong lượt chạy.
- Viewport 1440×1000 và 390×844; không tràn ngang ở màn hình đọc thư điện thoại trong lượt kiểm tra. Ảnh trong screenshots/.
- styles.css, sky-first-logo.png, favicon.png đối chiếu SHA-256 với file gốc: không thay đổi. index.html chỉ bổ sung CSS tương tác; JavaScript được chỉnh hành vi.

Test API bao phủ idempotency, thay đổi payload cùng mã, R2 lỗi trước gửi, CID, không đưa BCC vào MIME, provider timeout, quyền đọc thư, domain gửi tắt, inbound retry, thời gian phiên, phân trang cursor, xóa tài khoản không xóa EML dùng chung, sanitize HTML, tiếng Việt và attachment MIME.

Không suy diễn thành bảo đảm tuyệt đối: chưa kiểm thử trên Safari/Firefox, tải lớn, đa vùng, Email Routing/Resend/DNS thật, thao tác của toàn bộ module cũ, phục hồi backup, và toàn bộ tình huống nháp/tệp sau khi đóng tab. Không có chứng nhận “100% không lỗi”.
