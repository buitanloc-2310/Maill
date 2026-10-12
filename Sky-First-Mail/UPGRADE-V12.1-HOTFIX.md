# Sky First Mail V12.1 — D1 bootstrap hotfix

Sửa lỗi production khi `/api/bootstrap/status` trả `D1_EXEC_ERROR: CREATE TABLE IF NOT EXISTS send_operations (: incomplete input`.

## Nguyên nhân
`D1Database.exec()` của Cloudflare D1 xử lý chuỗi multi-statement theo từng dòng. Schema reliability V12 có câu `CREATE TABLE send_operations` trải trên nhiều dòng nên D1 cố thực thi riêng dòng `CREATE TABLE IF NOT EXISTS send_operations (` và báo `incomplete input`. SQLite local test không tái hiện vì `node:sqlite` chấp nhận script multi-line.

## Sửa
- Không dùng `env.DB.exec(RELIABILITY_SCHEMA)` cho reliability bootstrap nữa.
- Mỗi DDL được giữ thành một statement hoàn chỉnh trong `RELIABILITY_STATEMENTS`.
- `ensureSchema()` chạy từng statement bằng `env.DB.prepare(statement).run()`.
- Không reset D1, không xóa dữ liệu, không thay đổi schema logic. Migration `0007_reliability.sql` vẫn giữ nguyên cho Wrangler migration runner.

## Sau deploy
Mở `/api/bootstrap/status`. Endpoint phải không còn lỗi `incomplete input`. Nếu schema còn thiếu, V12.1 sẽ tạo các bảng reliability theo cách an toàn/idempotent.
