# Sky First Mail — Bản tổng kết audit và sửa lỗi R2

**Ngày:** 11/10/2026. Đây là bản làm việc tiếp tục từ ZIP đã nhận, không phải xác nhận nghiệm thu production.

## 1. Sửa đổi chính

1. Bảo vệ bootstrap với `SETUP_SECRET` tối thiểu 24 ký tự, khóa này chỉ nằm ở cấu hình server.
2. Rate limit đăng nhập; chuẩn hóa thời hạn session và thu hồi phiên khi đổi mật khẩu/reset/bootstrap nâng quyền.
3. Siết RBAC backend cho tạo/cập nhật tài khoản và reset mật khẩu Super Admin; bảo vệ Super Admin đang hoạt động cuối cùng.
4. Giới hạn kích thước body API và giới hạn đầu vào email/phân trang/quy tắc.
5. Giữ MIME/R2 nếu nhiều bản ghi còn tham chiếu; xóa thư theo mailbox khi xóa tài khoản; cleanup R2 fail-closed khi không xác định được tham chiếu.
6. Inbound receipt dedupe nguyên tử, chuẩn hóa ngày RFC và tôn trọng cờ nhận mail domain.
7. Sanitize MIME header/tên tệp/CID; giới hạn avatar thành ảnh raster có chữ ký khớp; HTML/SVG và file hoạt động chỉ tải xuống.
8. Làm sạch DOM email lần hai phía trình duyệt và CSP trong iframe; ảnh ngoài chỉ tải sau opt-in.
9. Tạo user/mailbox/preferences theo batch; lưu nháp kiểm tra quyền trước khi ghi R2.
10. Gateway chưa có contract file nên từ chối rõ ràng thư có attachment/inline image, không báo gửi như thể đã đính kèm.
11. Status dịch vụ phản ánh cấu hình domain/provider, không hard-code trạng thái nhận thư khỏe mạnh.
12. Thêm CI workflow Windows; giữ nguyên bản lồng trùng tên để không vô tình mất nguồn khác biệt.

## 2. Bằng chứng kiểm tra

- `npm run validate`: PASS.
- `npm run test:requirements`: 36/36 PASS.
- `migrations/0001_base.sql` đến `0008_transport_domains.sql` chạy theo thứ tự trên SQLite bộ nhớ: 8/8 PASS, 23 bảng.
- `PRAGMA foreign_key_check`: không phát hiện lỗi.
- `npm test`: BLOCKED do `postal-mime` chưa được cài trong môi trường; mạng DNS tới npm registry không dùng được.
- Browser E2E, thật sự gửi/nhận email, kiểm thử Gmail/Outlook/Proton/Yahoo/Fastmail, SPF/DKIM/DMARC/MX, tải cao, pentest, backup/restore và build EXE: chưa thực hiện/không có bằng chứng trong lượt này.
- Không deploy, không migrate D1 production, không sửa dữ liệu thật.

## 3. Điều kiện trước khi xem là hoàn tất

- Cài dependencies thành công rồi chạy đủ `npm test`.
- Thực thi browser E2E bằng Playwright đã được khai báo/ cài đặt; xác minh ảnh CID, liên kết, ảnh ngoài, file đính kèm và responsive mobile bằng browser thật.
- Chạy kiểm thử tích hợp trên staging với D1/R2 và provider thật; xác minh đường nhận/gửi email và quyền user/admin/super_admin.
- Build Windows installer trên Windows/GitHub Actions, kiểm tra artifact và chạy cài đặt/tháo cài.
- Chạy test hiệu năng, resilience, khôi phục backup trong staging.

**Trạng thái tổng:** đã sửa thêm và kiểm tra một phần có bằng chứng; chưa nghiệm thu toàn bộ. Không triển khai bản này lên production cho đến khi các gate bị chặn được hoàn tất.
