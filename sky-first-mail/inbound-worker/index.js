export default {
  async email(message, env, ctx) {
    const recipient = String(message.to || '').trim().toLowerCase();
    const sender = String(message.from || '').trim();
    try {
      let mailbox = await env.DB.prepare(`
        SELECT mb.id, mb.user_id, mb.address
        FROM mailboxes mb JOIN users u ON u.id=mb.user_id
        WHERE lower(mb.address)=lower(?) AND mb.is_active=1 AND u.status='active'
        LIMIT 1
      `).bind(recipient).first();

      if (!mailbox) {
        try {
          mailbox = await env.DB.prepare(`
            SELECT mb.id, mb.user_id, mb.address
            FROM aliases a
            JOIN mailboxes mb ON mb.id=a.mailbox_id
            JOIN users u ON u.id=mb.user_id
            WHERE lower(a.address)=lower(?) AND a.is_active=1 AND mb.is_active=1 AND u.status='active'
            LIMIT 1
          `).bind(recipient).first();
        } catch {}
      }

      if (!mailbox) {
        message.setReject('Mailbox does not exist.');
        return;
      }

      const subject = message.headers.get('subject') || '(Không có tiêu đề)';
      const messageId = message.headers.get('message-id') || null;
      const sentAt = message.headers.get('date') || null;
      let folder = 'inbox', starred = 0;

      try {
        const rules = await env.DB.prepare(`
          SELECT sender_contains, subject_contains, action_folder, action_star
          FROM mail_rules
          WHERE user_id=? AND is_active=1 AND (mailbox_id IS NULL OR mailbox_id=?)
          ORDER BY id ASC
        `).bind(mailbox.user_id, mailbox.id).all();
        for (const r of rules.results || []) {
          const senderOk = !r.sender_contains || sender.toLowerCase().includes(String(r.sender_contains).toLowerCase());
          const subjectOk = !r.subject_contains || subject.toLowerCase().includes(String(r.subject_contains).toLowerCase());
          if (senderOk && subjectOk) {
            if (['inbox','spam','trash'].includes(r.action_folder)) folder = r.action_folder;
            if (r.action_star) starred = 1;
          }
        }
      } catch {}

      const storageKey = `messages/inbound/${mailbox.id}/${Date.now()}-${crypto.randomUUID()}.eml`;
      const rawEmail = await new Response(message.raw).arrayBuffer();
      await env.MAIL_STORAGE.put(storageKey, rawEmail, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: { recipient, sender }
      });

      const result = await env.DB.prepare(`
        INSERT INTO messages (
          mailbox_id,direction,folder,message_id_header,sender,recipients_json,
          subject,preview,storage_key,raw_size,is_read,is_starred,status,sent_at,received_at
        ) VALUES (?,'inbound',?,?,?,?,?,?,?, ?,0,?,'received',?,CURRENT_TIMESTAMP)
      `).bind(
        mailbox.id, folder, messageId, sender, JSON.stringify([recipient]), subject, '',
        storageKey, rawEmail.byteLength, starred, sentAt
      ).run();

      try {
        await env.DB.prepare(`INSERT INTO notifications(user_id,type,title,body) VALUES(?,'mail',?,?)`)
          .bind(mailbox.user_id, `Thư mới từ ${sender}`, subject).run();
      } catch {}

      console.log('MAIL_RECEIVED', { id: result.meta?.last_row_id, from: sender, to: recipient, subject, folder, storageKey, size: rawEmail.byteLength });
    } catch (error) {
      console.error('MAIL_RECEIVE_FAILED', { from: sender, to: recipient, message: error?.message || String(error) });
      message.setReject('Temporary mail processing error.');
    }
  }
};
