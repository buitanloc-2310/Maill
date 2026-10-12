# Sky First Mail v3 — One Worker Webmail

Sky First Mail v3 là bản nâng cấp theo hướng **webmail thực thụ**, vẫn giữ mô hình **một Cloudflare Worker** cho cả website/API và Email Routing.

## Deploy hiện tại
- Worker: `sky-first-mail-inbound`
- Custom domain: `gmail.skyfirst.io.vn`
- Root directory trên Cloudflare/GitHub: `sky-first-mail`
- Deploy command: `npx wrangler deploy`
- D1 binding: `DB` -> `sky-first-mail`
- R2 binding: `MAIL_STORAGE` -> `sky-first-mail-storage`
- Secret gửi ngoài: `RESEND_API_KEY`

## Thiết lập an toàn lần đầu

- Trước khi khởi tạo tài khoản quản trị lần đầu, cấu hình secret `SETUP_SECRET` trên Cloudflare Worker bằng `npx wrangler secret put SETUP_SECRET` (dùng chuỗi ngẫu nhiên dài ít nhất 24 ký tự).
- Khi mở màn hình thiết lập lần đầu, nhập chính secret đó vào trường **Khóa thiết lập hệ thống**. Secret được gửi trong header `x-setup-secret`; không đưa secret vào mã frontend, tệp `.js`, Git hoặc tài liệu công khai.
- Với môi trường local, lưu secret trong `.dev.vars` không commit vào Git. Không dùng secret mẫu hoặc secret kiểm thử trong production.
- Nếu secret chưa được cấu hình hoặc quá ngắn, endpoint bootstrap sẽ từ chối khởi tạo. Đây là hành vi fail-closed có chủ đích.
- Sau khi thay đổi mã nguồn, chạy `npm ci`, `npm run validate`, `npm test` và `npm run test:requirements`. Không chạy migration hoặc deploy production chỉ để kiểm thử cục bộ.

## Cấu trúc ZIP

Gói phát hành sạch chỉ chứa một cây dự án `Sky-First-Mail/`, nơi có `package.json`, `wrangler.jsonc`, `src/`, `public/` và `migrations/`. Snapshot cũ được giữ ngoài gói phát hành để tránh nhầm lẫn và không bị trộn vào mã nguồn đang chạy.

## Luồng mail
- Nhận: Internet -> Cloudflare Email Routing -> `email()` -> R2 raw MIME + D1 metadata
- Gửi ngoài: Sky First Mail -> Resend API -> Gmail/Outlook/Internet
- Gửi nội bộ: Worker -> R2 + D1 -> mailbox nội bộ

## Nâng cấp v3
- Giao diện 3-pane webmail hoàn chỉnh hơn, responsive desktop/mobile.
- Bulk select thư + đánh dấu đã đọc, star, spam, trash.
- Bộ đếm thư từng folder và badge chưa đọc.
- Command palette `Ctrl + K`; phím `/` tìm kiếm; `C` mở compose.
- Compose được làm lại trực quan hơn, hỗ trợ file đính kèm và outbound Resend.
- Reader có thanh hành động, in thư và trạng thái nhận qua Sky First Mail.
- Avatar/profile dùng R2; tài khoản, session, chữ ký, rule, contacts, notification, alias và Admin Center vẫn giữ nguyên.
- Login/footer và toàn bộ visual được polish theo hệ nhận diện Sky First, không sao chép thương hiệu Gmail.

## Kiến trúc scale
Dữ liệu nặng (raw email, attachment, avatar) nằm ở **R2**. D1 giữ metadata/index để giảm phụ thuộc vào dung lượng DB. Với quy mô rất lớn, lớp metadata phải được chuyển sang sharding hoặc database ngoài (ví dụ PostgreSQL/Hyperdrive); không nên coi một D1 đơn lẻ là kiến trúc cho hàng triệu tài khoản. Xem `docs/SCALING.md`.

## Lưu ý
Không xóa D1/R2 hiện tại khi nâng cấp. `ensureSchema()` tự bổ sung schema cần thiết. Không commit `RESEND_API_KEY` vào repository.

## Kiểm thử và phát hành

- Chạy `npm run test:composer-sanitizer` để kiểm thử bộ làm sạch HTML trong Chromium mà không cần truy cập mạng.
- Chạy `npm run test:browser` để chạy sanitizer smoke trước, rồi kiểm thử giao diện Chromium bằng API giả lập cô lập (không gửi email thật).
- Xem `FINAL_RELEASE_GATE.md` và `docs/PRODUCTION-SMOKE-TESTS.md` trước khi chạy kiểm thử gửi/nhận thật hoặc tạo bộ cài Windows.
- Kiểm thử email thật yêu cầu tài khoản và hộp thư thử nghiệm do người vận hành kiểm soát; không tự động chạy trong CI.


## R6 mobile webmail verification

R6 improves phone navigation, reader sizing and Mail Studio responsive layout, and adds a network-free Chromium check. Run `npm run test:mobile` to test the real frontend with an isolated mock API. See [`docs/MOBILE-RESPONSIVE-R6.md`](docs/MOBILE-RESPONSIVE-R6.md) and [`AUDIT-AND-FIX-R6-20261012.md`](AUDIT-AND-FIX-R6-20261012.md) for scope and limitations. A mocked composer send is not evidence of real email delivery.


## Ảnh và liên kết bên ngoài trong email nhận

- Ảnh HTTP/HTTPS trong `<img src>`, các ứng viên URL an toàn trong `srcset` và thuộc tính `background` HTML cũ của email nhận được hiển thị tự động. `srcset` chỉ giữ ứng viên HTTP/HTTPS hoặc đường dẫn an toàn; `background` chỉ giữ URL HTTP/HTTPS hoặc đường dẫn cùng nguồn. Khung email vẫn chặn script, event handler, biểu mẫu, iframe nhúng và CSS có `url()`/`@import`; CSP chỉ cho phép ảnh same-origin, HTTP/HTTPS và ảnh raster data URI.
- Liên kết HTTP/HTTPS, `mailto:` và `tel:` được giữ lại nếu an toàn, mở trong tab/cửa sổ riêng với `noopener noreferrer nofollow`. Giao thức nguy hiểm vẫn bị loại bỏ.
- Yêu cầu ảnh ngoài tự động tải đồng nghĩa máy chủ ảnh của người gửi có thể ghi nhận địa chỉ IP/thời điểm tải ảnh hoặc dùng ảnh theo dõi. Khung thư đặt `referrerpolicy=no-referrer` để không gửi URL nguồn làm referrer; điều này không ngăn được việc máy chủ ảnh nhận yêu cầu.
