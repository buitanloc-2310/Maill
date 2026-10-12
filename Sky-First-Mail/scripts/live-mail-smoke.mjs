import crypto from 'node:crypto';

const REQUIRED_ACK = 'SEND_ONE_LIVE_TEST_EMAIL';
const baseRaw = process.env.MAIL_SMOKE_BASE_URL || '';
const cookie = process.env.MAIL_SMOKE_SESSION_COOKIE || '';
const recipient = (process.env.MAIL_SMOKE_TO || '').trim();
const allowRemote = process.env.MAIL_SMOKE_ALLOW_REMOTE === 'YES';
const allowProduction = process.env.MAIL_SMOKE_ALLOW_PRODUCTION === 'YES';
const ack = process.env.MAIL_SMOKE_CONFIRM_SEND || '';
const timeoutSeconds = Number(process.env.MAIL_SMOKE_REPLY_TIMEOUT_SECONDS || 300);

function stop(message, code = 2) {
  console.error(`[LIVE MAIL SMOKE: BLOCKED] ${message}`);
  process.exitCode = code;
}
function assertAddress(value, label) {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) throw new Error(`${label} must be one email address`);
  return value.toLowerCase();
}
function parseSender(value) {
  const m = String(value || '').match(/<([^<>]+)>/);
  return (m ? m[1] : String(value || '')).trim().toLowerCase();
}
async function readJson(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Server returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`${response.method || 'Request'} failed with HTTP ${response.status}: ${String(data.error || data.message || 'no server detail').slice(0, 300)}`);
  return data;
}

async function main() {
  if (ack !== REQUIRED_ACK) return stop(`No email was sent. Set MAIL_SMOKE_CONFIRM_SEND=${REQUIRED_ACK} only when you explicitly approve one real email.`);
  if (!baseRaw || !cookie || !recipient) return stop('No email was sent. Set MAIL_SMOKE_BASE_URL, MAIL_SMOKE_SESSION_COOKIE, and MAIL_SMOKE_TO. Session cookies are never printed.');
  let base;
  try { base = new URL(baseRaw); } catch { return stop('MAIL_SMOKE_BASE_URL must be a valid HTTPS URL.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return stop('MAIL_SMOKE_BASE_URL must use HTTPS and must not contain embedded credentials, query, or fragment.');
  if (base.pathname !== '/' && base.pathname !== '') return stop('MAIL_SMOKE_BASE_URL must be the application origin, without a path.');
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (!isLoopback && !allowRemote) return stop('Remote endpoints are disabled by default. Set MAIL_SMOKE_ALLOW_REMOTE=YES only after confirming the test environment.');
  if (base.hostname === 'gmail.skyfirst.io.vn' && !allowProduction) return stop('Production sending is disabled by default. Set MAIL_SMOKE_ALLOW_PRODUCTION=YES after review to target the production origin.');
  let to;
  try { to = assertAddress(recipient, 'MAIL_SMOKE_TO'); } catch (e) { return stop(e.message); }
  if (timeoutSeconds < 30 || timeoutSeconds > 1800 || !Number.isInteger(timeoutSeconds)) return stop('MAIL_SMOKE_REPLY_TIMEOUT_SECONDS must be an integer from 30 to 1800.');

  const baseOrigin = base.origin;
  const headers = { accept: 'application/json', cookie, origin: baseOrigin, 'x-sfm-request': '1' };
  async function api(path, init = {}) {
    const r = await fetch(new URL(path, baseOrigin), { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    r.method = init.method || 'GET';
    return readJson(r);
  }
  const me = await api('/api/me');
  const identities = await api('/api/sender-identities');
  const mailboxes = Array.isArray(identities.mailboxes) ? identities.mailboxes : [];
  const mailbox = mailboxes.find(x => x.is_primary === true || x.is_primary === 1) || mailboxes[0];
  if (!me.user || !mailbox?.id || !mailbox?.address) return stop('Authenticated session or active sender mailbox could not be resolved; no email was sent.');
  const from = parseSender(mailbox.address);
  try { assertAddress(from, 'selected sender mailbox'); } catch (e) { return stop(`${e.message}; no email was sent.`); }
  if (from.split('@').pop() === to.split('@').pop()) return stop('Recipient must be on a different provider/domain to test cross-provider delivery. No email was sent.');

  const token = crypto.randomBytes(6).toString('hex').toUpperCase();
  const subject = `[SKY FIRST MAIL LIVE TEST ${token}] Provider send/receive check`;
  const html = `<p>This is one explicitly approved Sky First Mail live test email.</p><p>Test token: <strong>${token}</strong></p><p>Please reply from the receiving provider and keep the token in the subject or body. The test waits for that reply in the Sky First inbox to verify the inbound path.</p><p>This message contains no attachment and no sensitive data.</p>`;
  const form = new FormData();
  form.set('requestId', crypto.randomUUID());
  form.set('mailboxId', String(mailbox.id));
  form.set('senderAddress', from);
  form.set('to', to);
  form.set('cc', '');
  form.set('bcc', '');
  form.set('subject', subject);
  form.set('html', html);
  form.set('text', `One explicitly approved Sky First Mail live test. Token: ${token}. Please reply keeping the token in subject or body to verify inbound receipt. No sensitive data or attachments.`);
  form.set('replyTo', '');
  form.set('priority', 'normal');
  const send = await api('/api/compose', { method: 'POST', body: form, headers: { 'x-sfm-request': '1' } });
  if (send.ok !== true || send.status === 'uncertain' || send.status === 'pending' || !send.operationId) return stop(`Provider submission did not confirm a completed operation (token ${token}, status ${send.status || 'unknown'}). Do not retry blindly. Review delivery events first.`);
  console.log(`[LIVE MAIL SMOKE] Provider accepted app operation ${String(send.operationId).slice(0, 120)}. Token=${token}`);
  console.log(`[LIVE MAIL SMOKE] Sent one message from ${from} to ${to}. Open the receiving mailbox and reply to this message now; waiting up to ${timeoutSeconds}s for that reply to arrive back in Sky First Mail.`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let found = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await api(`/api/messages?folder=inbox&q=${encodeURIComponent(token)}&limit=20`);
      const messages = Array.isArray(result.messages) ? result.messages : [];
      found = messages.find(m => {
        const sender = parseSender(m.sender || m.from || '');
        const searchable = `${m.subject || ''} ${m.preview || ''} ${m.sender || ''}`.toLowerCase();
        return searchable.includes(token.toLowerCase()) && sender === to;
      }) || null;
      if (found) break;
      lastError = null;
    } catch (e) { lastError = e; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!found) {
    const suffix = lastError ? ` Last inbox poll error: ${String(lastError.message || lastError).slice(0, 250)}` : '';
    return stop(`Outbound submission was accepted, but no reply from ${to} containing token ${token} was found within ${timeoutSeconds}s. Delivery/inbound is not PASS.${suffix}`, 3);
  }
  console.log(JSON.stringify({ result: 'PASS', environment: baseOrigin, from, to, token, providerOperationId: send.operationId, inboundMessageId: found.id, note: 'One live external email was sent and a reply was matched in the Sky First inbox.' }, null, 2));
}
main().catch(error => stop(`Unexpected failure. No credentials are logged. ${String(error?.message || error).slice(0, 400)}`, 2));
