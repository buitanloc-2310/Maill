# Trung tâm Thư điện tử Sky First — Nâng cấp 10.2

## Phạm vi
- Đổi nhận diện giao diện thành “Trung tâm Thư điện tử Sky First”, dùng logo gốc.
- Màn đăng nhập mới, dải 6 giá trị toàn chiều rộng, footer Quyền riêng tư / Điều khoản / Hỗ trợ.
- Việt hóa các nhãn giao diện chính và loại bỏ thông tin hạ tầng khỏi giao diện người dùng.
- Danh bạ và API liên hệ chỉ dành cho Quản trị viên / Siêu quản trị viên.
- Quản trị tài khoản: tạo, sửa, khóa/mở, đặt lại mật khẩu và xóa vĩnh viễn có xác nhận email.
- Xóa tài khoản xóa bản ghi người dùng, các dữ liệu phụ thuộc theo khóa ngoại và cố gắng xóa các object thư/nháp/avatar liên quan.
- Không cho xóa chính tài khoản đang đăng nhập hoặc Siêu quản trị viên cuối cùng.
- Bí danh có API bật/tắt và xóa.
- Endpoint tình trạng không còn công khai tên công nghệ/hạ tầng.
- Giữ kiến trúc gửi/nhận và multi-domain hiện có.

## Danh bạ
User thường không nhìn thấy menu Danh bạ và gọi trực tiếp API sẽ nhận 403. Composer của user thường không được lấy danh sách toàn hệ thống.

## Avatar
Tài khoản nội bộ tiếp tục dùng ảnh đại diện đã tải lên. Với người gửi ngoài hệ thống, giao diện dùng fallback chữ cái khi không có nguồn ảnh đáng tin cậy. Không giả định có thể truy xuất ảnh hồ sơ Gmail của mọi địa chỉ.

## Kiểm tra trước khi đóng gói
- `node --check` cho `src/index.js`, `public/app.js`, `public/v3.js`, `public/v4.js`, `public/v5.js`.
- Rà chuỗi kỹ thuật nhạy cảm trong giao diện public.
- Rà quyền `/api/directory` và `/api/contacts`.
- Rà endpoint DELETE tài khoản và bảo vệ Siêu quản trị viên cuối cùng.
