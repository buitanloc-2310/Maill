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
