# Sky First Mail — FINAL GitHub Ready

Đây là **một repo duy nhất** cho Sky First Mail. Không có “bản 1/bản 2” tách rời.

Repo gồm:

- Web app `sky-first-mail` cho `email.skyfirst.io.vn`.
- Email Worker `sky-first-mail-inbound` trong thư mục `inbound-worker/`.
- D1 migrations đầy đủ.
- R2 dùng chung để lưu MIME, avatar và tệp liên quan.

## Tính năng đã có trong bản này

### Sky First Account

- First-run bootstrap Super Admin; hoàn tất một lần thì khóa bootstrap.
- Đăng nhập bằng email + mật khẩu.
- PBKDF2-SHA256, salt riêng từng tài khoản.
- Session cookie HttpOnly / Secure / SameSite=Lax.
- Hồ sơ kiểu account center: tên, avatar, trạng thái, role.
- Admin quyết định từng user có được đổi:
  - tên;
  - avatar;
  - mật khẩu;
  - chữ ký;
  - giao diện.
- Light / Dark / System / Sky Blue.
- Xem các phiên đăng nhập và thu hồi phiên khác.
- Đổi mật khẩu và tự đăng xuất các phiên khác.
- Notification center.

### Sky First Mail

- Inbox / Starred / Sent / Drafts / Spam / Trash.
- Search theo người gửi, người nhận, subject, preview.
- Reading pane desktop; layout mobile riêng.
- Render HTML email trong sandboxed iframe.
- Tải attachment từ MIME đang lưu trong R2.
- Star / Mark read / Spam / Trash.
- Compose, Reply, Forward.
- **Gửi nội bộ** giữa các mailbox Sky First hoạt động ngay, không cần provider ngoài.
- File đính kèm khi gửi nội bộ, tối đa 8 MB tổng.
- Contacts cá nhân + Directory nội bộ.
- Chữ ký email.
- Mail rules theo sender/subject → Spam/Trash/Star.
- Inbound worker áp dụng rule khi thư mới đến.
- Alias nhận mail được inbound worker hỗ trợ.

### Admin Center

- Dashboard: users, active mailboxes, mail count, unread, dung lượng raw mail.
- Tạo user bằng **đầy đủ địa chỉ email**; không hard-code `@skyfirst.io.vn`.
- User / Admin / Super Admin.
- Active / Disabled.
- Cấp hoặc khóa từng quyền profile.
- Reset password và thu hồi session của user.
- Tạo alias cho mailbox.
- Danh sách domain quản lý.
- Audit log.

## Giới hạn duy nhất liên quan hạ tầng hiện tại

Gửi ra Gmail/Outlook/domain bên ngoài **chưa thể tự hoạt động chỉ bằng Email Routing Free**. Bản này không giả vờ gửi thành công: nếu người nhận không phải mailbox/alias nội bộ, API trả thông báo cần outbound provider.

Sau này có thể nối Resend, MailChannels/provider khác hoặc Cloudflare Email Sending khi tài khoản đáp ứng điều kiện mà không cần viết lại UI/account/database.

## Cloudflare resources hiện tại

- D1 binding: `DB`
- D1 database: `sky-first-mail`
- D1 id: `eda8015d-b594-4bab-a740-50554a6d5f74`
- R2 binding: `MAIL_STORAGE`
- R2 bucket: `sky-first-mail-storage`
- Inbound Worker: `sky-first-mail-inbound`
- Web Worker: `sky-first-mail`

## Deploy từ GitHub

### 1. Up repo

Đưa **toàn bộ nội dung thư mục này** lên một GitHub repository.

### 2. Cài dependencies và chạy migrations

```bash
npm install
npm run db:migrate
```

Migrations sẽ chạy theo thứ tự:

- `0001_base.sql`
- `0002_accounts.sql`
- `0003_workspace.sql`

### 3. Deploy web app

```bash
npm run deploy
```

Sau đó gắn custom domain:

`email.skyfirst.io.vn`

### 4. Cập nhật inbound worker bằng code FINAL

Worker inbound bạn đã có đang hoạt động. Để nâng nó lên bản hỗ trợ alias + mail rules + notification:

```bash
npm run deploy:inbound
```

Sau đó giữ Catch-all:

`Email Routing → Catch-all → sky-first-mail-inbound`

### 5. Mở web

Truy cập:

`https://email.skyfirst.io.vn`

Nếu `setup_completed=false`, màn hình tạo Super Admin xuất hiện. Sau khi setup xong, trang setup khóa và domain chỉ còn login.

## Lưu ý tài khoản test cũ

Database hiện có thể đang có `test@skyfirst.io.vn` với password hash `TEMP`. Đó chỉ là mailbox test inbound, không phải password đăng nhập hợp lệ.

Bạn có thể bootstrap bằng email khác. Nếu dùng đúng email đã tồn tại, bootstrap sẽ nâng tài khoản đó thành Super Admin và thay hash mật khẩu thật.

## GitHub / secrets

Không commit mật khẩu, token API hoặc secret outbound vào repo. Nếu nối provider gửi mail sau này, lưu API key bằng Cloudflare Secret.

D1 database ID và tên R2 trong `wrangler.jsonc` là định danh resource, không phải password.

## Kiểm tra source

```bash
npm run validate
```
