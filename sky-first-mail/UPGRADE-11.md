# Sky First Mail 11.0 — bản nâng cấp vận hành

Gói này nâng cấp trực tiếp bản Maill-main(6).zip, giữ giao diện 10.2. Không thay thiết kế, màu thương hiệu, logo hay bố cục chính. styles.css và hai ảnh gốc giữ nguyên từng byte; stability.css bổ sung focus bàn phím, xử lý tràn, chiều cao modal và giảm chuyển động theo cài đặt thiết bị. Giao diện thêm nút Tải thêm thư để truy cập thư cũ hơn.

## Đã sửa / bổ sung

- Nhật ký yêu cầu gửi bền vững trong D1; mã gửi cố định trong cửa sổ soạn. Gọi lại cùng mã và nội dung không tạo thêm thư.
- Lưu EML vào R2 trước khi gọi nhà cung cấp. Ghi các bản thư nội bộ và trạng thái hoàn tất trong một batch giao dịch.
- Nếu kết quả gửi bên ngoài không xác định, chặn gửi lại tự động để tránh trùng. Có API xem nhật ký cho chủ tài khoản và super_admin. Đây không phải hàng đợi tự phục hồi.
- Ảnh CID được đính kèm ra Resend, kèm content_id. Tệp giới hạn 12 MiB tổng và 30 tệp; tối đa 50 người nhận.
- Khi người nhận ngoài chỉ nằm ở CC/BCC, gửi To qua nhà cung cấp để đáp ứng yêu cầu To; không phát thêm bản nội bộ cho những To đó. Cloudflare Email Routing phải hoạt động để nhận các To nội bộ trong trường hợp này.
- Cấu hình tắt gửi tên miền không còn bị bật lại mỗi lần Worker khởi động. Kiểm tra cờ nhận của tên miền khi nhận thư.
- Session hết hạn được so sánh theo thời gian thật, tránh lỗi ISO có chữ T so với CURRENT_TIMESTAMP có dấu cách.
- Chặn request ghi khác nguồn; thêm giới hạn thử đăng nhập theo IP; setup yêu cầu secret; không lộ raw lỗi backend.
- Chặn admin thường tạo quyền quản trị cao, đặt lại mật khẩu super_admin; thu hồi phiên khi đổi quyền.
- Xóa tài khoản không xóa EML vẫn được tham chiếu bởi hộp thư khác.
- HTML thư được lọc bằng parser; đính kèm HTML/SVG không được mở inline cùng nguồn; ảnh upload hồ sơ giới hạn định dạng raster.
- Lưu nháp được tuần tự hóa, không tự đánh dấu đã lưu khi nội dung thay đổi trong lúc request đang chạy. Không đóng cửa sổ khi người dùng chọn lưu nhưng lưu thất bại.
- Chuyển tiếp HTML dùng dữ liệu API thay vì đọc DOM iframe bị sandbox chặn.
- Danh sách thư có cursor; phản hồi tìm kiếm cũ không ghi đè phản hồi mới.
- Có package-lock.json, bộ test, môi trường local dùng SQLite/R2 trong bộ nhớ và tài liệu vận hành.

## Giới hạn cần hiểu đúng

Không có hệ thống nào được bảo đảm chạy 100 năm không bảo trì. Bản này chưa có MFA, IMAP/SMTP client, đồng bộ offline, full-text search thân thư, antivirus tệp, phục hồi backup tự động, webhook xác nhận delivered/bounced hoặc cơ chế tự retry nhật ký gửi. “sent” với thư ngoài nghĩa là nhà cung cấp đã nhận yêu cầu, không chứng minh người nhận đã nhận thư.

Nhật ký uncertain/accepted_pending_local phải đối chiếu thủ công, không tự phát lại. Resend giữ khóa idempotency 24 giờ; ứng dụng giữ khóa nội bộ đến khi quản trị xử lý dữ liệu. Không dùng khóa cũ để tự gửi lại sau cửa sổ 24 giờ.

Bản nháp giữ metadata tệp cũ khi chỉ lưu nội dung; việc mở lại nháp chưa tự phục hồi tệp/ảnh nội tuyến vào bộ chọn tệp. Người dùng vẫn phải chọn lại tệp trước khi gửi. Chưa bảo đảm lưu thư đang soạn khi đóng hẳn tab hoặc thiết bị mất điện. Lọc HTML có thể loại style không an toàn hoặc style nâng cao của email; không thay giao diện ứng dụng.

Chưa triển khai hay gửi email thật trong vòng này. DNS, SPF/DKIM/DMARC, Cloudflare Email Routing, Resend, D1/R2 production và tải nhiều người dùng cần nghiệm thu riêng.

## Tài liệu nguồn

- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://resend.com/docs/dashboard/emails/embed-inline-images
