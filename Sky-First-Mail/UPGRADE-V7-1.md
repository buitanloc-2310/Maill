# Sky First Mail 7.1

- Composer chuyển sang mặt soạn thư toàn màn hình, không dùng modal nhỏ làm trải nghiệm chính.
- People autocomplete cho To/Cc/Bcc từ directory nội bộ và Contacts.
- Người nhận được hiển thị theo tên + email khi chọn từ gợi ý.
- HTML inline image được tích hợp trực tiếp vào pipeline FormData hiện hữu, không monkey-patch `fetch`/`FormData` toàn cục.
- HTML asset có thể ghép theo tên file và gửi qua MIME CID.
- Giữ Mail Studio: HTML/Visual/Preview, template, signature, alias, draft, test-send, attachments.
- Loại bỏ runtime `v7.js` thử nghiệm từng gây rủi ro trắng trang.
- Backend/API/mail storage hiện hữu được giữ nguyên.
