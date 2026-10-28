import { hmacSha256Hex } from './security.js';
import { isDangerousAttachmentName } from './content-policy.js';

export const ACCOUNT_TYPES = ['personal', 'organization', 'service', 'delegated'];
export const VERIFICATION_STATUSES = ['unverified', 'verified', 'suspended', 'revoked'];
export const EMAIL_CATEGORIES = ['personal', 'transactional', 'notification', 'promotional'];

const FAKE_BADGE_PATTERN = /[✓✔☑✅✪]|\[(?:verified|tích\s*xanh|đã\s*xác\s*minh)\]/gi;

export function sanitizeDisplayName(name = '', isVerified = false) {
  let clean = String(name || '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
  if (!isVerified) {
    clean = clean.replace(FAKE_BADGE_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
  }
  return clean;
}

export function hasSpoofedBadgeInName(name = '') {
  FAKE_BADGE_PATTERN.lastIndex = 0;
  return FAKE_BADGE_PATTERN.test(String(name || ''));
}

export function extractEmailAddress(raw = '') {
  const str = String(raw || '').trim();
  const m = str.match(/<([^<>]+)>/);
  return (m ? m[1] : str).trim().toLowerCase();
}

export function verificationExplanation(record) {
  if (!record || !record.is_verified || record.verification_status !== 'verified') {
    if (record?.verification_status === 'suspended') return 'Tích xanh xác minh của tài khoản này đang tạm đình chỉ.';
    if (record?.verification_status === 'revoked') return 'Tích xanh xác minh của tài khoản này đã bị thu hồi.';
    return 'Tài khoản chưa được cấp tích xanh xác minh bởi Quản trị viên Sky First Mail.';
  }
  const typeLabel = {
    personal: 'Tài khoản cá nhân chính thức',
    organization: 'Tài khoản tổ chức / đơn vị thuộc Sky First',
    service: 'Tài khoản dịch vụ hệ thống',
    delegated: 'Danh tính ủy quyền được xác minh'
  }[record.account_type] || 'Tài khoản đã xác minh';
  const dept = record.department ? ` · Đơn vị: ${record.department}` : '';
  return `${typeLabel}${dept}. Đã được Quản trị viên Sky First Mail xác minh danh tính và quyền sử dụng tên miền.`;
}

export async function getSenderVerificationMap(env, rawAddresses = []) {
  const addresses = [...new Set(rawAddresses.map(extractEmailAddress).filter(Boolean))].slice(0, 100);
  const map = {};
  if (!addresses.length) return map;
  const qs = addresses.map(() => '?').join(',');
  try {
    const direct = await env.DB.prepare(`
      SELECT lower(u.email) addr, u.id user_id, u.display_name, u.avatar_key, u.is_verified, u.verification_status,
             u.account_type, u.department, u.verified_at, u.verification_reason,
             v.display_name verifier_name
      FROM users u
      LEFT JOIN users v ON v.id = u.verified_by
      WHERE lower(u.email) IN (${qs})
    `).bind(...addresses).all();
    for (const r of direct.results || []) {
      map[r.addr] = {
        userId: r.user_id,
        displayName: r.display_name,
        avatarKey: r.avatar_key || null,
        isVerified: Number(r.is_verified) === 1 && r.verification_status === 'verified',
        status: r.verification_status || 'unverified',
        accountType: r.account_type || 'personal',
        department: r.department || null,
        verifiedAt: r.verified_at || null,
        verifiedBy: r.verifier_name || 'Quản trị viên Sky First',
        reason: r.verification_reason || null,
        explanation: verificationExplanation(r)
      };
    }
    const aliasRows = await env.DB.prepare(`
      SELECT lower(a.address) addr, u.id user_id, u.display_name, u.avatar_key, u.is_verified, u.verification_status,
             u.account_type, u.department, u.verified_at, u.verification_reason,
             v.display_name verifier_name
      FROM aliases a
      JOIN mailboxes mb ON mb.id = a.mailbox_id
      JOIN users u ON u.id = mb.user_id
      LEFT JOIN users v ON v.id = u.verified_by
      WHERE a.is_active = 1 AND lower(a.address) IN (${qs})
    `).bind(...addresses).all();
    for (const r of aliasRows.results || []) {
      if (!map[r.addr]) {
        map[r.addr] = {
          userId: r.user_id,
          displayName: r.display_name,
          avatarKey: r.avatar_key || null,
          isVerified: Number(r.is_verified) === 1 && r.verification_status === 'verified',
          status: r.verification_status || 'unverified',
          accountType: 'alias',
          department: r.department || null,
          verifiedAt: r.verified_at || null,
          verifiedBy: r.verifier_name || 'Quản trị viên Sky First',
          reason: r.verification_reason || null,
          explanation: verificationExplanation(r)
        };
      }
    }
  } catch {}
  return map;
}

export async function inspectDomainBimiAndDns(domainRow, dnsJsonFn) {
  const domain = String(domainRow.domain || '').toLowerCase();
  const selector = String(domainRow.dkim_selector || 'resend').trim().toLowerCase();
  const token = `skyfirst-mail-verification=${domainRow.verification_token || ''}`;
  const cleanTxt = (res) => (res?.Answer || []).map(x => String(x.data || '').replace(/"\s+"/g, '').replace(/^"|"$/g, '').trim());

  const [ownRes, mxRes, spfRes, dkimRes, dmarcRes, bimiRes] = await Promise.all([
    dnsJsonFn(`_skyfirst-mail.${domain}`, 'TXT').catch(() => ({ Answer: [] })),
    dnsJsonFn(domain, 'MX').catch(() => ({ Answer: [] })),
    dnsJsonFn(domain, 'TXT').catch(() => ({ Answer: [] })),
    dnsJsonFn(`${selector}._domainkey.${domain}`, 'TXT').catch(() => ({ Answer: [] })),
    dnsJsonFn(`_dmarc.${domain}`, 'TXT').catch(() => ({ Answer: [] })),
    dnsJsonFn(`default._bimi.${domain}`, 'TXT').catch(() => ({ Answer: [] }))
  ]);

  const ownTxt = cleanTxt(ownRes);
  const mxRecords = (mxRes?.Answer || []).map(x => String(x.data || '').trim()).filter(Boolean);
  const rootTxt = cleanTxt(spfRes);
  const dkimTxt = cleanTxt(dkimRes);
  const dmarcTxt = cleanTxt(dmarcRes);
  const bimiTxt = cleanTxt(bimiRes);

  const ownershipOk = !!domainRow.verification_token && ownTxt.some(x => x === token);
  const mxOk = mxRecords.length > 0;
  const spfRecord = rootTxt.find(x => /^v=spf1\b/i.test(x)) || null;
  const spfOk = !!spfRecord && (/[-~]all\s*$/i.test(spfRecord));
  const dkimRecord = dkimTxt.find(x => /v=DKIM1|k=rsa|p=/i.test(x)) || (dkimRes?.Answer?.length ? String(dkimRes.Answer[0].data || '') : null);
  const dkimOk = !!dkimRecord;
  const dmarcRecord = dmarcTxt.find(x => /^v=DMARC1\b/i.test(x)) || null;
  const dmarcPolicyMatch = dmarcRecord ? dmarcRecord.match(/\bp\s*=\s*([a-z]+)/i) : null;
  const dmarcPolicy = dmarcPolicyMatch ? dmarcPolicyMatch[1].toLowerCase() : null;
  const dmarcPctMatch = dmarcRecord ? dmarcRecord.match(/\bpct\s*=\s*(\d+)/i) : null;
  const dmarcPct = dmarcPctMatch ? Number(dmarcPctMatch[1]) : 100;
  const dmarcOk = !!dmarcRecord;
  const dmarcBimiEligible = dmarcOk && ['quarantine', 'reject'].includes(dmarcPolicy) && dmarcPct === 100;

  const bimiRecord = bimiTxt.find(x => /^v=BIMI1\b/i.test(x)) || null;
  const bimiLogoMatch = bimiRecord ? bimiRecord.match(/\bl\s*=\s*([^;\s]+)/i) : null;
  const bimiVmcMatch = bimiRecord ? bimiRecord.match(/\ba\s*=\s*([^;\s]+)/i) : null;
  const bimiLogoUrl = bimiLogoMatch ? bimiLogoMatch[1].trim() : null;
  const bimiVmcUrl = bimiVmcMatch ? bimiVmcMatch[1].trim() : null;
  const bimiLogoValid = !!bimiLogoUrl && /^https:\/\/.+\.svg$/i.test(bimiLogoUrl);
  const bimiVmcConfigured = !!bimiVmcUrl && /^https:\/\/.+\.(?:pem|cer|crt)$/i.test(bimiVmcUrl);

  let externalStatus = 'unconfigured';
  let externalLabel = 'Chưa cấu hình';
  if (!spfOk && !dkimOk && !dmarcOk && !bimiRecord) {
    externalStatus = 'unconfigured';
    externalLabel = 'Chưa cấu hình';
  } else if (!spfOk || !dkimOk || !dmarcOk) {
    externalStatus = 'missing_dns';
    externalLabel = 'Thiếu bản ghi DNS bắt buộc (SPF/DKIM/DMARC)';
  } else if (!dmarcBimiEligible || !bimiLogoValid) {
    externalStatus = 'not_eligible';
    externalLabel = 'Chưa đạt điều kiện xác minh BIMI (cần DMARC p=quarantine/reject, pct=100 và logo SVG Tiny PS)';
  } else if (!bimiVmcConfigured) {
    externalStatus = 'configured_pending';
    externalLabel = 'Đã cấu hình BIMI cơ bản · Chờ chứng thư VMC/CMC để hiển thị tích xanh trên Gmail';
  } else {
    externalStatus = 'verified_dns';
    externalLabel = 'Đã xác minh cấu hình DNS (SPF, DKIM, DMARC, BIMI + VMC) · Tùy thuộc nhà cung cấp bên ngoài';
  }

  const remediation = [];
  if (!ownershipOk) remediation.push(`Thêm bản ghi TXT tại _skyfirst-mail.${domain} với giá trị: ${token}`);
  if (!mxOk) remediation.push(`Cấu hình bản ghi MX cho ${domain} trỏ về máy chủ nhận thư (Cloudflare Email Routing).`);
  if (!spfOk) remediation.push(`Thêm bản ghi TXT SPF tại ${domain}: v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`);
  if (!dkimOk) remediation.push(`Thêm bản ghi DKIM tại ${selector}._domainkey.${domain} theo khóa công khai từ nhà cung cấp gửi thư (Resend/Gateway).`);
  if (!dmarcOk) remediation.push(`Thêm bản ghi TXT DMARC tại _dmarc.${domain}: v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@${domain}`);
  else if (!dmarcBimiEligible) remediation.push(`Nâng chính sách DMARC tại _dmarc.${domain} từ p=${dmarcPolicy || 'none'} lên p=quarantine hoặc p=reject (pct=100) để đủ điều kiện BIMI.`);
  if (!bimiLogoValid) remediation.push(`Thêm bản ghi TXT BIMI tại default._bimi.${domain}: v=BIMI1; l=https://mail.skyfirst.io.vn/bimi-logo.svg; a=${domainRow.bimi_vmc_url || ''}`);
  if (!bimiVmcConfigured) remediation.push(`Lưu ý quan trọng đối với Gmail: Google yêu cầu chứng thư VMC/CMC hợp lệ (được cấp bởi tổ chức chứng thực như DigiCert hoặc Entrust) trong tham số a= của bản ghi default._bimi.${domain}. Sky First Mail không tự vẽ tích xanh giả trên Gmail.`);

  return {
    ownership: ownershipOk,
    mx: mxOk,
    txt: ownTxt,
    mxRecords,
    spf: { ok: spfOk, record: spfRecord },
    dkim: { ok: dkimOk, selector, record: dkimRecord },
    dmarc: { ok: dmarcOk, bimiEligible: dmarcBimiEligible, policy: dmarcPolicy, pct: dmarcPct, record: dmarcRecord },
    bimi: { configured: !!bimiRecord, logoValid: bimiLogoValid, vmcConfigured: bimiVmcConfigured, logoUrl: bimiLogoUrl, vmcUrl: bimiVmcUrl, record: bimiRecord },
    externalStatus,
    externalLabel,
    compatibility: {
      skyFirstInternal: 'Hỗ trợ đầy đủ (do Quản trị viên Sky First cấp và kiểm soát tại máy chủ)',
      gmail: bimiVmcConfigured && dmarcBimiEligible && spfOk && dkimOk ? 'Đủ điều kiện kỹ thuật DNS/BIMI+VMC (hiển thị cuối cùng do Google quyết định)' : 'Chưa đủ điều kiện tích xanh Gmail (cần SPF + DKIM + DMARC p=quarantine/reject + BIMI SVG + chứng thư VMC/CMC)',
      yahooAndAppleMail: bimiLogoValid && dmarcBimiEligible && spfOk && dkimOk ? 'Đủ điều kiện hiển thị logo BIMI' : 'Chưa đủ điều kiện BIMI',
      outlook: 'Outlook sử dụng cơ chế xác thực SPF/DKIM/DMARC và danh tiếng người gửi riêng'
    },
    recommendedDnsRecords: [
      { type: 'TXT', name: `_skyfirst-mail.${domain}`, value: token, purpose: 'Xác minh quyền sở hữu tên miền trên Sky First Mail' },
      { type: 'TXT', name: domain, value: 'v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all', purpose: 'SPF xác thực máy chủ gửi' },
      { type: 'TXT', name: `${selector}._domainkey.${domain}`, value: 'v=DKIM1; k=rsa; p=<PUBLIC_KEY_TU_RESEND>', purpose: 'Chữ ký số DKIM' },
      { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; pct=100; adkim=r; aspf=r; rua=mailto:postmaster@${domain}`, purpose: 'Chính sách DMARC bắt buộc cho BIMI' },
      { type: 'TXT', name: `default._bimi.${domain}`, value: `v=BIMI1; l=${domainRow.bimi_logo_url || 'https://mail.skyfirst.io.vn/bimi-logo.svg'}; a=${domainRow.bimi_vmc_url || ''}`, purpose: 'Hiển thị logo thương hiệu BIMI & chứng thư VMC' }
    ],
    remediation,
    checkedAt: new Date().toISOString()
  };
}

export async function getSpamPolicy(env) {
  const defaults = {
    maxRecipientsPerMessage: 50,
    defaultHourlyLimit: 50,
    defaultDailyLimit: 200,
    newAccountHourlyLimit: 20,
    domainDailyLimit: 2000,
    riskBlockThreshold: 80,
    riskHoldThreshold: 60,
    bounceAlertThresholdPct: 10,
    complaintAlertThresholdPct: 0.5
  };
  try {
    const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key='spam_policy' LIMIT 1`).first();
    if (row?.value_json) return { ...defaults, ...JSON.parse(row.value_json) };
  } catch {}
  return defaults;
}

export async function createSecurityAlert(env, severity, category, title, detail = {}, userId = null) {
  try {
    await env.DB.prepare(`INSERT INTO security_alerts(severity, category, title, detail_json, user_id) VALUES(?, ?, ?, ?, ?)`)
      .bind(severity, category, title, JSON.stringify(detail || {}), userId || null).run();
  } catch {}
}

export function assessContentAndRecipientRisk({ user, recipients = [], subject = '', text = '', html = '', attachments = [], recentHourCount = 0 }) {
  let score = 0;
  const flags = [];

  for (const a of attachments) {
    if (isDangerousAttachmentName(a?.name || a?.filename || '')) {
      score += 90;
      flags.push(`Tệp đính kèm có phần mở rộng thực thi nguy hiểm: ${a.name || a.filename}`);
    }
  }

  const combinedBody = `${subject}\n${text}\n${html}`;
  const urls = [...combinedBody.matchAll(/https?:\/\/([^\s"'<>)\]]+)/gi)].map(m => m[0]);
  if (urls.some(u => /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?:[:/]|$)/i.test(u))) {
    score += 45;
    flags.push('Nội dung chứa liên kết sử dụng địa chỉ IP trực tiếp thay vì tên miền.');
  }
  if (urls.some(u => /^https?:\/\/[^/]*@/i.test(u))) {
    score += 55;
    flags.push('Liên kết chứa ký tự @ đánh lừa địa chỉ đích (URL userinfo trick).');
  }
  if (urls.some(u => /xn--/i.test(u))) {
    score += 30;
    flags.push('Liên kết chứa tên miền mã hóa Punycode (cần kiểm tra chống giả mạo tên miền).');
  }

  // Check mismatched anchor text vs href domain in HTML
  const anchorMatches = [...String(html || '').matchAll(/<a\b[^>]*href=["']https?:\/\/([^/"'>]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [, hrefHost, inner] of anchorMatches) {
    const plainInner = inner.replace(/<[^>]+>/g, '').trim();
    const lookalikeHost = plainInner.match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,24})(?:\/|$)/i)?.[1];
    if (lookalikeHost && lookalikeHost.toLowerCase() !== hrefHost.toLowerCase() && !hrefHost.toLowerCase().endsWith('.' + lookalikeHost.toLowerCase())) {
      score += 50;
      flags.push(`Văn bản hiển thị liên kết (${lookalikeHost}) khác với tên miền đích thực tế (${hrefHost}).`);
      break;
    }
  }

  // Account age and sudden burst detection
  const createdMs = user?.created_at ? Date.parse(String(user.created_at).includes('T') ? user.created_at : user.created_at.replace(' ', 'T') + 'Z') : 0;
  const isNewAccount = createdMs > 0 && (Date.now() - createdMs) < 24 * 60 * 60 * 1000 && !user?.is_verified;
  if (isNewAccount && recipients.length >= 15) {
    score += 35;
    flags.push('Tài khoản mới khởi tạo chưa xác minh tích xanh gửi cho nhiều người nhận cùng lúc.');
  }
  if (recentHourCount >= 30 && recipients.length >= 10) {
    score += 25;
    flags.push('Tần suất gửi thư tăng cao trong 1 giờ qua.');
  }

  const clamped = Math.min(100, score);
  const level = clamped >= 80 ? 'critical' : clamped >= 60 ? 'high' : clamped >= 30 ? 'medium' : 'low';
  return { score: clamped, level, flags };
}

export async function evaluateOutboundPolicy(env, user, fromMb, { to = [], cc = [], bcc = [], subject = '', text = '', html = '', attachments = [], emailCategory = 'personal' }) {
  const policy = await getSpamPolicy(env);
  const allRecipients = [...new Set([...to, ...cc, ...bcc].map(extractEmailAddress).filter(Boolean))];
  if (allRecipients.length > Number(policy.maxRecipientsPerMessage || 50)) {
    return { allowed: false, status: 400, error: `Mỗi thư tối đa ${policy.maxRecipientsPerMessage || 50} người nhận.` };
  }

  // 1. Check Suppression List (manual_block, hard_bounce, unsubscribe, complaint)
  if (allRecipients.length) {
    const qs = allRecipients.map(() => '?').join(',');
    const suppressed = await env.DB.prepare(`SELECT email, reason FROM suppression_list WHERE lower(email) IN (${qs})`).bind(...allRecipients).all().catch(() => ({ results: [] }));
    const blocked = (suppressed.results || []).filter(r => {
      if (r.reason === 'unsubscribe' && ['transactional'].includes(emailCategory)) return false;
      return true;
    });
    if (blocked.length) {
      const reasons = blocked.map(b => `${b.email} (${b.reason === 'hard_bounce' ? 'địa chỉ từng bị trả lại vĩnh viễn' : b.reason === 'unsubscribe' ? 'đã hủy đăng ký nhận thư' : b.reason === 'complaint' ? 'đã báo cáo spam' : 'nằm trong danh sách chặn'})`).join(', ');
      return { allowed: false, status: 400, error: `Không thể gửi tới địa chỉ bị chặn hoặc ngừng nhận thư: ${reasons}.` };
    }
  }

  // 2. Check Account & Domain Rate Limits
  const hourlyLimit = Number(user.hourly_send_limit || policy.defaultHourlyLimit || 50);
  const dailyLimit = Number(user.daily_send_limit || policy.defaultDailyLimit || 200);
  const hourRow = await env.DB.prepare(`
    SELECT COUNT(*) ops, COALESCE(SUM(json_array_length(m.recipients_json)), 0) rcpts
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE (mb.user_id = ? OR m.actor_user_id = ?) AND m.direction = 'outbound' AND m.created_at >= datetime('now', '-1 hour')
  `).bind(user.id, user.id).first().catch(() => ({ ops: 0, rcpts: 0 }));
  const dayRow = await env.DB.prepare(`
    SELECT COUNT(*) ops, COALESCE(SUM(json_array_length(m.recipients_json)), 0) rcpts
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE (mb.user_id = ? OR m.actor_user_id = ?) AND m.direction = 'outbound' AND m.created_at >= datetime('now', '-24 hours')
  `).bind(user.id, user.id).first().catch(() => ({ ops: 0, rcpts: 0 }));

  const recentHourCount = Math.max(Number(hourRow?.ops || 0), Number(hourRow?.rcpts || 0));
  const recentDayCount = Math.max(Number(dayRow?.ops || 0), Number(dayRow?.rcpts || 0));

  if (recentHourCount + allRecipients.length > hourlyLimit) {
    await createSecurityAlert(env, 'medium', 'rate_limit.hourly', `Tài khoản ${user.email} vượt giới hạn gửi theo giờ`, { recentHourCount, attempted: allRecipients.length, hourlyLimit }, user.id);
    return { allowed: false, status: 429, error: `Tài khoản đã chạm giới hạn gửi theo giờ (${hourlyLimit} người nhận/giờ). Vui lòng thử lại sau.` };
  }
  if (recentDayCount + allRecipients.length > dailyLimit) {
    await createSecurityAlert(env, 'high', 'rate_limit.daily', `Tài khoản ${user.email} vượt giới hạn gửi theo ngày`, { recentDayCount, attempted: allRecipients.length, dailyLimit }, user.id);
    return { allowed: false, status: 429, error: `Tài khoản đã chạm giới hạn gửi trong 24 giờ (${dailyLimit} người nhận/ngày).` };
  }

  // 3. Evaluate Pre-Send Risk
  const risk = assessContentAndRecipientRisk({ user, recipients: allRecipients, subject, text, html, attachments, recentHourCount });
  if (risk.score >= Number(policy.riskBlockThreshold || 80)) {
    await createSecurityAlert(env, 'high', 'outbound.risk.blocked', `Chặn thư có rủi ro bảo mật cao từ ${user.email}`, { subject, riskScore: risk.score, flags: risk.flags }, user.id);
    return { allowed: false, status: 400, error: `Hệ thống bảo vệ uy tín đã chặn gửi thư do phát hiện rủi ro cao: ${risk.flags.join(' ')}`, risk };
  }

  return {
    allowed: true,
    holdForReview: risk.score >= Number(policy.riskHoldThreshold || 60),
    risk
  };
}

export async function generateUnsubscribeUrl(env, baseOrigin, recipientEmail) {
  const secret = String(env.SETUP_SECRET || 'sky-first-mail-unsubscribe-key');
  const email = extractEmailAddress(recipientEmail);
  const token = await hmacSha256Hex(secret, `unsub:${email}`);
  const origin = baseOrigin && baseOrigin.startsWith('http') ? baseOrigin : 'https://mail.skyfirst.io.vn';
  return `${origin}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
}

export async function verifyUnsubscribeToken(env, recipientEmail, token) {
  const secret = String(env.SETUP_SECRET || 'sky-first-mail-unsubscribe-key');
  const email = extractEmailAddress(recipientEmail);
  if (!email || !token) return false;
  const expected = await hmacSha256Hex(secret, `unsub:${email}`);
  return expected === String(token).trim();
}

export async function recallSentMessage(env, user, messageId, reason, services) {
  const msg = await services.ownsMessage(env, user.id, messageId);
  if (!msg) return { ok: false, status: 404, error: 'Không tìm thấy thư đã gửi.' };
  if (msg.direction !== 'outbound') return { ok: false, status: 400, error: 'Chỉ có thể thu hồi thư do bạn đã gửi đi.' };
  if (msg.status === 'recalled') return { ok: false, status: 409, error: 'Thư này đã được thu hồi trước đó.' };

  const cleanReason = String(reason || 'Người gửi yêu cầu thu hồi thư').trim().slice(0, 300);
  const parseList = (j) => { try { return JSON.parse(j || '[]'); } catch { return []; } };
  const allRecipients = [...new Set([...parseList(msg.recipients_json), ...parseList(msg.cc_json), ...parseList(msg.bcc_json)].map(extractEmailAddress).filter(Boolean))];

  const recipientOutcomes = [];
  let recalledCount = 0;
  let externalCount = 0;
  let alreadyReadCount = 0;

  for (const addr of allRecipients) {
    const mb = await services.resolveMailbox(env, addr);
    if (!mb) {
      externalCount++;
      recipientOutcomes.push({
        recipient: addr,
        scope: 'external',
        status: 'cannot_recall_external',
        wasRead: null,
        detail: 'Thư đã chuyển tới máy chủ email bên ngoài (Gmail/Outlook/Internet) ngoài phạm vi kiểm soát của Sky First Mail; không thể xóa từ xa.'
      });
      continue;
    }

    // Locate internal recipient copy by storage_key or message_id_header
    const targetCopy = await env.DB.prepare(`
      SELECT id, is_read, status, folder FROM messages
      WHERE mailbox_id = ? AND direction = 'inbound' AND (storage_key = ? OR (message_id_header IS NOT NULL AND message_id_header = ?))
      ORDER BY id DESC LIMIT 1
    `).bind(mb.id, msg.storage_key, msg.message_id_header || '').first();

    if (!targetCopy) {
      recipientOutcomes.push({
        recipient: addr,
        scope: 'internal',
        status: 'already_deleted',
        wasRead: null,
        detail: 'Bản thư phía người nhận không còn trong hộp thư (đã bị xóa trước đó).'
      });
      continue;
    }

    const wasRead = Number(targetCopy.is_read) === 1;
    if (wasRead) alreadyReadCount++;

    await env.DB.prepare(`
      UPDATE messages
      SET status = 'recalled', recalled_at = CURRENT_TIMESTAMP, recall_reason = ?, preview = '[Thư đã được người gửi thu hồi]'
      WHERE id = ?
    `).bind(cleanReason, targetCopy.id).run();

    recalledCount++;
    recipientOutcomes.push({
      recipient: addr,
      scope: 'internal',
      status: 'recalled',
      wasRead,
      messageId: targetCopy.id,
      detail: wasRead
        ? 'Đã thu hồi khỏi hộp thư nội bộ (Lưu ý: người nhận đã mở thư trước thời điểm thu hồi).'
        : 'Đã thu hồi thành công khỏi hộp thư nội bộ trước khi người nhận mở thư.'
    });

    await services.notify(env, mb.user_id || mb.owner_user_id, `Thư từ ${msg.sender} đã được thu hồi`, `Tiêu đề: ${msg.subject || '(Không có tiêu đề)'} · Lý do: ${cleanReason}`, 'recall');
  }

  let overallStatus = 'cannot_recall';
  if (recalledCount > 0 && recalledCount === allRecipients.length) overallStatus = 'recalled';
  else if (recalledCount > 0) overallStatus = 'partial';

  const newMessageStatus = overallStatus === 'recalled' ? 'recalled' : overallStatus === 'partial' ? 'recall_partial' : msg.status;
  await env.DB.prepare(`UPDATE messages SET status = ?, recalled_at = CURRENT_TIMESTAMP, recall_reason = ? WHERE id = ?`)
    .bind(newMessageStatus, cleanReason, msg.id).run();

  const op = await env.DB.prepare(`SELECT id FROM send_operations WHERE storage_key = ? LIMIT 1`).bind(msg.storage_key).first().catch(() => null);
  const recallInsert = await env.DB.prepare(`
    INSERT INTO message_recalls(message_id, operation_id, requester_user_id, sender_address, reason, overall_status, total_recipients, recalled_count, external_count, already_read_count, details_json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    msg.id,
    op?.id || null,
    user.id,
    msg.sender,
    cleanReason,
    overallStatus,
    allRecipients.length,
    recalledCount,
    externalCount,
    alreadyReadCount,
    JSON.stringify(recipientOutcomes)
  ).run();

  await services.audit(env, user.id, 'mail.recalled', 'message', msg.id, {
    overallStatus,
    recalledCount,
    externalCount,
    alreadyReadCount,
    reason: cleanReason
  });

  return {
    ok: true,
    status: 200,
    recallId: recallInsert.meta?.last_row_id || null,
    overallStatus,
    recalledCount,
    externalCount,
    alreadyReadCount,
    totalRecipients: allRecipients.length,
    outcomes: recipientOutcomes,
    disclaimer: 'Thu hồi thư khỏi hộp thư nội bộ không thể bảo đảm xóa các bản sao đã được người nhận tải xuống, chụp màn hình, sao chép hoặc chuyển tiếp trước thời điểm thu hồi. Đối với người nhận bên ngoài (Gmail, Outlook), hệ thống giữ nguyên lịch sử gửi và không tự nhận xóa được thư trên máy chủ ngoài.'
  };
}

export function evaluateInboundAuth(message, managedDomainSet = new Set()) {
  const authHeader = String(message?.headers?.get('authentication-results') || '').toLowerCase();
  const spfHeader = String(message?.headers?.get('received-spf') || '').toLowerCase();
  const dkimHeader = String(message?.headers?.get('dkim-signature') || '');
  const senderAddr = extractEmailAddress(message?.from || '');
  const senderDomain = senderAddr.split('@')[1] || '';

  const spf = /spf=pass/.test(authHeader) || /^pass\b/.test(spfHeader)
    ? 'pass'
    : /spf=(fail|softfail)/.test(authHeader) || /^(fail|softfail)\b/.test(spfHeader)
      ? 'fail'
      : 'none';
  const dkim = /dkim=pass/.test(authHeader)
    ? 'pass'
    : /dkim=fail/.test(authHeader)
      ? 'fail'
      : dkimHeader ? 'present' : 'none';
  const dmarc = /dmarc=pass/.test(authHeader)
    ? 'pass'
    : /dmarc=fail/.test(authHeader)
      ? 'fail'
      : 'none';

  const claimsManagedDomain = managedDomainSet.has(senderDomain);
  const spoofSuspected = (dmarc === 'fail' || spf === 'fail') || (claimsManagedDomain && spf !== 'pass' && dkim !== 'pass' && (authHeader.length > 0 || spfHeader.length > 0));

  return {
    spf,
    dkim,
    dmarc,
    senderDomain,
    claimsManagedDomain,
    spoofSuspected,
    checkedAt: new Date().toISOString()
  };
}

export async function getReputationDashboard(env) {
  const [ops, evs, supps, queueStats, domains] = await Promise.all([
    env.DB.prepare(`SELECT status, count(*) n FROM send_operations GROUP BY status`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT event_type, count(*) n FROM delivery_events GROUP BY event_type`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT reason, count(*) n FROM suppression_list GROUP BY reason`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT status, count(*) n FROM send_queue GROUP BY status`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT id, domain, status, send_enabled, receive_enabled, external_verification_status, daily_send_limit FROM managed_domains ORDER BY domain`).all().catch(() => ({ results: [] }))
  ]);

  const opMap = Object.fromEntries((ops.results || []).map(r => [r.status, Number(r.n || 0)]));
  const evMap = Object.fromEntries((evs.results || []).map(r => [r.event_type, Number(r.n || 0)]));
  const suppMap = Object.fromEntries((supps.results || []).map(r => [r.reason, Number(r.n || 0)]));
  const qMap = Object.fromEntries((queueStats.results || []).map(r => [r.status, Number(r.n || 0)]));

  const totalSent = (opMap.completed || 0) + (opMap.accepted || 0);
  const accepted = (evMap.accepted || 0) + (evMap.delivered || 0) + (evMap['email.delivered'] || 0);
  const bounced = (evMap.bounced || 0) + (evMap['email.bounced'] || 0);
  const complained = (evMap.complained || 0) + (evMap['email.complained'] || 0);
  const rejected = (opMap.failed || 0) + (evMap.rejected || 0) + (evMap['email.rejected'] || 0);
  const waiting = (qMap.queued || 0) + (qMap.undo_window || 0) + (qMap.scheduled || 0) + (qMap.paused || 0);

  const denom = Math.max(totalSent, accepted, 1);
  const bounceRatePct = totalSent > 0 ? Number(((bounced / denom) * 100).toFixed(2)) : 0;
  const complaintRatePct = totalSent > 0 ? Number(((complained / denom) * 100).toFixed(2)) : 0;

  return {
    metrics: {
      totalSent,
      waitingInQueue: waiting,
      providerAccepted: accepted,
      rejectedOrFailed: rejected,
      bounced,
      spamComplaints: complained,
      bounceRatePct,
      complaintRatePct
    },
    suppressionSummary: {
      manualBlock: suppMap.manual_block || 0,
      hardBounce: suppMap.hard_bounce || 0,
      unsubscribe: suppMap.unsubscribe || 0,
      complaint: suppMap.complaint || 0
    },
    queueBreakdown: qMap,
    domains: domains.results || [],
    dataSourceNote: 'Số liệu được tổng hợp trực tiếp từ cơ sở dữ liệu giao dịch gửi thư và sự kiện webhook thực tế của nhà cung cấp. Hệ thống không tự suy đoán điểm số nội bộ của Google Postmaster.'
  };
}
