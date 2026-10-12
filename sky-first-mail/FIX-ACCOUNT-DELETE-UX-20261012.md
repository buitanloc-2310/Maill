# Sky First Mail — cải thiện thao tác xóa tài khoản

## Thay đổi
- Thay `prompt()` nhập lại email và `confirm()` trình duyệt bằng hộp xác nhận ngay trong giao diện.
- Hộp xác nhận nêu rõ email tài khoản và cảnh báo xóa vĩnh viễn hộp thư/dữ liệu liên quan.
- Nút xóa có trạng thái `Đang xóa…`, khóa nút khi request chạy; lỗi hiển thị trong hộp thoại và có thể thử lại.
- Không cho xóa tài khoản đang đăng nhập; tiếp tục giữ bảo vệ quyền xóa tài khoản quản trị và Siêu quản trị viên cuối cùng ở API.
- API hiện có vẫn được giữ nguyên xác nhận `confirmEmail` ở request, nhưng email mục tiêu được gửi từ bản ghi đang được quản trị viên chọn; bước xác nhận trực quan là hành động đồng ý rõ ràng của người dùng.

## Kiểm tra
- `node --check public/app.js`: PASS
- `node --check src/index.js`: PASS
- Bộ test mail không chạy được do gói `postal-mime` chưa được cài trong môi trường kiểm tra.
- `tests/requirements.test.mjs`: 60/62 pass; 2 lỗi do `.github/workflows/build-windows.yml` thiếu sẵn trong source ZIP.
- Chưa thể kiểm tra endpoint trên Cloudflare production từ môi trường này. Cần triển khai bản ZIP và thử xóa một tài khoản thử nghiệm trước khi dùng trên tài khoản thật.
