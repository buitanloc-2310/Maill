# Vận hành dài hạn

## Trạng thái gửi cần đối chiếu

GET /api/send-operations: nhật ký của người đang đăng nhập. Super admin dùng GET /api/admin/send-operations để xem tối đa 200 yêu cầu gần nhất. Các endpoint yêu cầu cookie phiên hợp lệ; không công khai qua internet cho người chưa đăng nhập.

| Trạng thái | Ý nghĩa / xử lý |
|---|---|
| preparing / prepared | Yêu cầu đã giữ mã, có thể chưa gọi provider. Kiểm tra storage_key và log Worker. |
| sending / uncertain | Có thể provider đã nhận nhưng ứng dụng chưa có kết quả. Đối chiếu dashboard/provider; không gửi lại mù. |
| accepted / accepted_pending_local | Provider nhận thư nhưng ghi dữ liệu cục bộ chưa xong. Giữ nguyên EML và nhật ký, khôi phục bản ghi sau đối chiếu; không phát lại email. |
| failed | Lỗi trước gửi hoặc provider từ chối rõ ràng. Sửa nguyên nhân; chỉ tạo thư mới sau khi xác nhận chưa gửi. |
| completed | Ghi thư cục bộ hoàn tất. Với thư ngoài vẫn chưa xác nhận delivered. |

Mã gửi cố định trong cửa sổ soạn. Chỉnh nội dung sau một lần gửi đã được ghi nhận sẽ bị 409 nếu dùng mã cũ. Khi kết quả không rõ, giữ cửa sổ và mã operationId, tránh mở thư mới rồi gửi lại. Hiện chưa có nút quản trị retry/reconcile tự động.

## Sao lưu và khôi phục

- Sao lưu cả DB và R2; DB đơn lẻ không có nội dung EML, tệp nháp và ảnh hồ sơ.
- Trước mỗi bản cập nhật: export D1, sao chép R2 vào vị trí lưu độc lập, lưu mã nguồn/lockfile/cấu hình và thời điểm snapshot; secret giữ trong kho riêng.
- Thử khôi phục trên staging: nhập DB, phục hồi đúng object key R2, thử đọc thư và tải tệp, kiểm tra quyền người dùng. Chỉ chuyển traffic sau nghiệm thu.
- Không xóa object trong messages/outbound hoặc send_operations chưa đối chiếu; nhiều hộp thư có thể dùng chung một EML.
- Nhật ký gửi không tự xóa. Thiết lập chính sách lưu giữ sau khi thống nhất nhu cầu lưu trữ và dung lượng.

## Lịch bảo trì gợi ý

Hằng ngày kiểm tra lỗi nhận/gửi và nhật ký chưa hoàn tất; hằng tuần kiểm tra backup; hằng tháng cập nhật dependency trên staging và chạy test; định kỳ thử khôi phục, rà soát tài khoản/quyền, hạn tên miền và trạng thái DNS. Không tự cập nhật production chỉ dựa trên số phiên bản.

Các ca nghiệm thu thật: gửi/nhận Gmail hoặc Outlook, To/CC/BCC hỗn hợp, alias, CID, UTF-8, tệp lớn, quyền người dùng thường/admin/root, mất mạng, xoay secret và phục hồi backup. Chưa có nghiệm thu production trong gói này.
