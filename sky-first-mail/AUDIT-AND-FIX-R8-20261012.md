# Sky First Mail R8 — External Images and Links

**Ngày:** 12/10/2026  
**Phiên bản package:** `sky-first-mail` 12.0.4  
**Nguồn:** cây dự án sạch R7 CLEAN; không nhúng ZIP cũ, không trộn snapshot cũ.

## Thay đổi đã thực hiện

1. `public/app.js`: bỏ cơ chế mặc định loại bỏ ảnh từ xa và nút yêu cầu tải ảnh thủ công. Ảnh email sử dụng URL HTTP/HTTPS được giữ lại và tải tự động.
2. CSP của iframe đọc thư: `img-src 'self' data: http: https:` cho phép ảnh cùng nguồn, ảnh raster data URI và ảnh HTTP/HTTPS bên ngoài; vẫn khóa script, kết nối, iframe lồng, biểu mẫu, object và các nguồn không được phép.
3. `srcset`: giữ những ứng viên có URL HTTP/HTTPS hoặc đường dẫn an toàn và descriptor `w`/`x` đúng định dạng; loại URL/protocol không an toàn.
4. Thuộc tính `background` HTML cũ: cho phép URL ảnh HTTP/HTTPS/đường dẫn cùng nguồn. CSS có `url()` hoặc `@import` tiếp tục bị loại bỏ để giới hạn tài nguyên chủ động ngoài ý muốn.
5. Liên kết HTTP/HTTPS, `mailto:` và `tel:` được giữ nếu hợp lệ, mở ở tab/cửa sổ mới, đặt `rel="noopener noreferrer nofollow"`. Scheme nguy hiểm như `javascript:`/`vbscript:` bị loại bỏ; event handler vẫn bị xóa.
6. Iframe và tài liệu bên trong tiếp tục đặt `referrerpolicy="no-referrer"`; điều này ngăn gửi URL nguồn làm referrer nhưng không ngăn máy chủ ảnh biết địa chỉ IP/thời điểm có yêu cầu.
7. Bài kiểm thử `scripts/composer-sanitizer-smoke.cjs` nay chạy helper đọc email thực trong Chromium, kiểm tra ảnh HTTP/HTTPS, `srcset`, `background`, liên kết an toàn và việc chặn script/event-handler/URL nguy hiểm.
8. `scripts/browser-smoke.cjs` được cập nhật để xác minh rằng khi E2E chạy được, ảnh ngoài vẫn giữ `src` và CSP cho phép HTTP/HTTPS, đồng thời liên kết ngoài giữ thuộc tính an toàn.
9. Đồng bộ version `package.json` và `package-lock.json` sang `12.0.4`; cập nhật README và sơ đồ nguồn để phản ánh cấu trúc ZIP sạch.

## Kết quả kiểm tra thực tế

| Lệnh/kiểm tra | Kết quả | Ghi chú |
|---|---|---|
| `npm run validate` | **PASS** | Tất cả file được liệt kê trong script đều qua cú pháp. |
| `npm run test:requirements` | **PASS — 62/62** | Không test nào thất bại hoặc bị bỏ qua. |
| `npm run test:composer-sanitizer` | **PASS** | Chromium thật kiểm tra helper soạn thư và helper đọc email; ảnh HTTP/HTTPS, `srcset`, `background` và link an toàn được giữ, nội dung chủ động bị loại. |
| `npm run test:mobile` | **PASS** | Smoke test mobile trên Chromium với API giả lập; không gửi thư thật. |
| `npm test` | **BLOCKED** | Dừng khi import `postal-mime`: package không có trong `node_modules`; chưa xác nhận integration suite email. |
| `npm run test:browser` | **BLOCKED** | Bước sanitizer PASS; browser E2E dừng vì chính sách trình duyệt chặn `127.0.0.1`. |
| Email thật giữa các provider | **NOT RUN** | Không gửi email thật trong lần sửa này. |
| Build Windows / production | **NOT RUN** | Không build `.exe`, không deploy, không chạy migration từ xa và không sửa dữ liệu production. |

## Kiểm tra trên chính ZIP đã giải nén sạch

- Đã giải nén gói phát hành vào thư mục mới, không dùng cây phát triển ban đầu.
- ZIP chỉ có một root `Sky-First-Mail/`, 94 file, không có ZIP lồng, bản dự án cũ lồng, `.env`, `.dev.vars`, `node_modules` hoặc `.git`.
- `SHA256SUMS.txt` có 93 mục và tất cả hash khớp nội dung trong archive.
- Chạy lại từ bản giải nén: `npm run validate` PASS; `npm run test:requirements` 62/62 PASS; `npm run test:composer-sanitizer` PASS; `npm run test:mobile` PASS.
- `npm test` từ bản giải nén vẫn BLOCKED với `ERR_MODULE_NOT_FOUND` cho `postal-mime`.
- `npm run test:browser` từ bản giải nén chạy PASS bước sanitizer, sau đó BLOCKED khi Chromium bị chính sách tổ chức chặn `127.0.0.1`.

## Lưu ý riêng tư và phạm vi

- Ảnh ngoài tự tải có thể cho máy chủ ảnh của người gửi biết địa chỉ IP, thời điểm yêu cầu và định danh theo dõi nếu URL chứa token duy nhất. `no-referrer` không che địa chỉ IP; nó chỉ ngăn gửi URL nguồn làm referrer.
- Các ảnh qua `img src`, ứng viên `srcset` được lọc và thuộc tính `background` HTML cũ được hỗ trợ. CSS `url()`/`@import` vẫn bị loại bỏ có chủ đích.
- Kiểm thử Chromium xác nhận HTML đã qua lọc và chính sách cho phép tài nguyên; chưa chứng minh tất cả máy chủ ảnh ngoài đều còn hoạt động hoặc không chặn hotlink.
- Đây là bản sửa chức năng đọc email; không thay đổi backend, D1/R2, schema hoặc cấu hình gửi thư, và không phải xác nhận toàn hệ thống đã nghiệm thu.
