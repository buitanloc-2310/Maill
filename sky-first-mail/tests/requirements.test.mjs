import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import { isAllowedAvatarImage, safeAttachmentResponse, safeMimeType, safeMimeFilename, isDangerousAttachmentName } from '../src/lib/content-policy.js';
import { boundedRequest, RELIABILITY_STATEMENTS, readStreamBounded } from '../src/lib/security.js';
import { database, DatabaseSync } from './db.mjs';
import { sendGateway, sendExternal } from '../src/lib/transport.js';
import { sanitizeDisplayName, hasSpoofedBadgeInName, assessContentAndRecipientRisk, inspectDomainBimiAndDns } from '../src/lib/governance.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);
const atRoot = (p) => new URL(p, root);

function listAllFiles(dirUrl, prefix = '') {
  const entries = readdirSync(dirUrl, { withFileTypes: true });
  let out = [];
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(listAllFiles(new URL(`${e.name}/`, dirUrl), rel));
    else out.push(rel);
  }
  return out.sort();
}

function sanitizerUnderTest() {
  const source = read('../src/lib/mail.js');
  const start = source.indexOf('export function cleanEmailHtml(html=\'\') {');
  const end = source.indexOf('\n}\n\nfunction encHeader', start);
  assert.ok(start >= 0 && end > start, 'cleanEmailHtml source should be locatable');
  const declaration = source.slice(start, end + 2).replace('export function', 'function');
  return new Function(`${declaration}; return cleanEmailHtml;`)();
}

function mimeBuilderUnderTest() {
  const source = read('../src/lib/mail.js');
  const cleanStart = source.indexOf('export function cleanEmailHtml(html=\'\') {');
  const cleanEnd = source.indexOf('\n}\n\nfunction encHeader', cleanStart);
  const builderStart = source.indexOf('function encHeader', cleanEnd);
  assert.ok(cleanStart >= 0 && cleanEnd > cleanStart && builderStart > cleanEnd, 'MIME builder source should be locatable');
  const clean = source.slice(cleanStart, cleanEnd + 2).replace('export function', 'function');
  const builders = source.slice(builderStart).replace('export async function buildMime', 'async function buildMime');
  return new Function('safeMimeType', 'safeMimeFilename', `${clean}; ${builders}; return buildMime;`)(safeMimeType, safeMimeFilename);
}

test('total project file count is strictly <= 39 files with no legacy gmail.skyfirst.io.vn references or AI dependencies', () => {
  const allFiles = listAllFiles(root);
  assert.ok(allFiles.length <= 39, `Expected <= 39 files, found ${allFiles.length}: ${allFiles.join(', ')}`);
  for (const file of allFiles) {
    if (/\.(png|ico|jpg|webp)$/i.test(file)) continue;
    const content = readFileSync(atRoot(file), 'utf8');
    if (file !== 'tests/requirements.test.mjs') {
      assert.doesNotMatch(content, /gmail\.skyfirst\.io\.vn/i, `File ${file} must not reference gmail.skyfirst.io.vn`);
    }
    assert.doesNotMatch(content, /api\.openai\.com|anthropic\.com|generativelanguage\.googleapis\.com/i, `File ${file} must not contain AI API endpoints`);
  }
});

test('email HTML sanitizer blocks active markup, event handlers and encoded script URLs', () => {
  const cleanEmailHtml = sanitizerUnderTest();
  const clean = cleanEmailHtml('<table><tr><td style="color:red">Xin chào</td></tr></table><img src="x" onerror="alert(1)"><svg onload="alert(1)"><script>x</script></svg><a href="jav&#x61;script:alert(1)">click</a><iframe srcdoc="x"></iframe>');
  assert.match(clean, /<table>/i);
  assert.match(clean, /color:red/i);
  assert.doesNotMatch(clean, /onerror|onload|javascript:|<script|<svg|<iframe|srcdoc/i);
});

test('requested compose library ships five HTML documents and ten snippets inline', () => {
  const catalog = JSON.parse(read('../public/library/compose-library.json'));
  const templates = catalog.templates || [];
  const htmlTemplates = templates.filter(x => x.kind === 'html' && x.body_html);
  assert.equal(htmlTemplates.length, 5);
  assert.equal(templates.filter(x => x.kind === 'chat' && x.body_text).length, 10);
  for (const item of htmlTemplates) {
    assert.match(item.body_html, /<!doctype html/i);
    assert.match(item.body_html, /<body[\s>]/i);
  }
});

test('PWA manifest icons, BIMI SVG Tiny PS logo, and static-only service worker exist', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(existsSync(atRoot(icon.src.replace(/^\//, 'public/'))), `missing ${icon.src}`);
  assert.ok(existsSync(atRoot('public/bimi-logo.svg')), 'missing BIMI SVG logo');
  const bimiSvg = read('../public/bimi-logo.svg');
  assert.match(bimiSvg, /baseProfile="tiny-ps"/);
  assert.match(bimiSvg, /<title>Sky First<\/title>/);
  const sw = read('../public/sw.js');
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /cache: 'no-store'/);
  assert.match(sw, /sky-first-mail-static-v3-startupfix/);
  assert.match(read('../public/index.html'), /app\.js\?v=12\.0\.5/);
});

test('attachment policy is consistent across composer and API (100 files, 12 MiB aggregate)', () => {
  const compose = read('../src/lib/compose.js');
  const api = read('../src/index.js');
  const ui = read('../public/v5.js');
  assert.match(compose, /attachments\.length\+inlineAttachments\.length>100/);
  assert.match(compose, /12\*1024\*1024/);
  assert.match(api, /attachments\.length\+inlineAttachments\.length>100/);
  assert.match(api, /12\*1024\*1024/);
  assert.match(ui, /count>100/);
  assert.match(ui, /12\*1024\*1024/);
});

test('package lock root metadata matches package manifest', () => {
  const pkg = JSON.parse(read('../package.json'));
  const lock = JSON.parse(read('../package-lock.json'));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});

test('send composer holds a stable request key across retry attempts', () => {
  const ui = read('../public/v5.js');
  const backend = read('../src/lib/compose.js');
  assert.match(ui, /activeRequestId\|\|\(activeRequestId=crypto\.randomUUID\(\)\)/);
  assert.match(ui, /fd\.set\('requestId',requestId\|\|activeRequestId\)/);
  assert.match(backend, /request\.headers\.get\('idempotency-key'\)/i);
});

test('external images in received emails load by default while active email content remains isolated', () => {
  const ui = read('../public/app.js');
  assert.match(ui, /function prepareMailHtml\(html\)/);
  assert.match(ui, /if\(name==='srcset'\)/);
  assert.ok(ui.includes('const imagePolicy="\'self\' data: http: https:"'));
  assert.match(ui, /renderMailFrame\(\)/);
  assert.match(ui, /referrerpolicy="no-referrer"/);
  assert.match(ui, /noopener noreferrer nofollow/);
  assert.match(ui, /script-src 'none'/);
});

test('Proofline records message hashes when saved and exposes owner-scoped verification UI/API', () => {
  const api = read('../src/index.js');
  const compose = read('../src/lib/compose.js');
  const ui = read('../public/app.js');
  assert.match(api, /content_sha256 TEXT/);
  assert.match(api, /proofline\.integrity\.mismatch/);
  assert.ok(api.includes('/proofline$/'));
  assert.match(compose, /const contentSha256=await digest/);
  assert.match(ui, /id=\"prooflineBtn\"/);
  assert.match(ui, /SHA-256 hiện tại/);
});

test('Sky First branding assets have valid image signatures and expected icon dimensions', () => {
  const pngs = [
    ['public/sky-first-logo.png', 2000, 2000],
    ['public/app-icon-192.png', 192, 192],
    ['public/app-icon-512.png', 512, 512],
    ['public/favicon-app.png', 256, 256],
  ];
  for (const [file, width, height] of pngs) {
    const b = readFileSync(atRoot(file));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} must be PNG`);
    assert.equal(b.readUInt32BE(16), width, `${file} width`);
    assert.equal(b.readUInt32BE(20), height, `${file} height`);
  }
});

test('bootstrap and admin endpoints enforce server-side security controls', () => {
  const api = read('../src/index.js');
  assert.match(api, /env\.SETUP_SECRET/);
  assert.match(api, /x-setup-secret/);
  assert.match(api, /constantTimeEqual/);
  assert.match(api, /b\.role!=='user'&&user\.role!=='super_admin'/);
  assert.match(api, /target\.role!=='user'&&user\.role!=='super_admin'/);
  assert.match(api, /Chỉ Siêu quản trị viên được quản lý mật khẩu tài khoản quản trị/);
  assert.match(api, /INSERT INTO login_limits/);
  assert.match(api, /retry-after/);
});

test('web entry document points to existing local assets only', () => {
  const html = read('../public/index.html');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js(?:\?[^"]*)?"/);
  assert.match(html, /src="\/v5\.js"/);
  for (const file of ['styles.css','app.js','v5.js','sw.js','manifest.webmanifest','sky-first-logo.png','favicon-app.png','app-icon-192.png','bimi-logo.svg']) {
    assert.ok(existsSync(atRoot(`public/${file}`)), `missing referenced static asset: ${file}`);
  }
});

test('session expiry is compared as a parsed timestamp, not lexicographic text', () => {
  const auth = read('../src/lib/auth.js');
  assert.match(auth, /datetime\(s\.expires_at\)>datetime\('now'\)/);
  assert.doesNotMatch(auth, /s\.expires_at>CURRENT_TIMESTAMP/);
});

test('inline attachments only render verified raster images; active content is forced to download', async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.equal(isAllowedAvatarImage('image/png', png), true);
  assert.equal(isAllowedAvatarImage('image/svg+xml', new TextEncoder().encode('<svg/>')), false);
  assert.equal(isAllowedAvatarImage('image/png', new TextEncoder().encode('<html>')), false);

  const safe = safeAttachmentResponse({filename:'photo.png',mimeType:'image/png',content:png}, true);
  assert.equal(safe.headers.get('content-type'), 'image/png');
  assert.match(safe.headers.get('content-disposition'), /^inline;/);

  const hostile = safeAttachmentResponse({filename:'../../evil\r\nX-Bad: yes.svg',mimeType:'image/svg+xml',content:new TextEncoder().encode('<svg onload="alert(1)"/>')}, true);
  assert.equal(hostile.headers.get('content-type'), 'application/octet-stream');
  assert.match(hostile.headers.get('content-disposition'), /^attachment;/);
});

test('API request bodies are bounded even without a trustworthy Content-Length header', async () => {
  const tooLargeHeader = new Request('https://mail.skyfirst.io.vn/api/login', {
    method: 'POST', headers: {'content-length':'9'}, body: 'x'
  });
  await assert.rejects(() => boundedRequest(tooLargeHeader, 4), error => error.status === 413);

  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('123')); controller.enqueue(new TextEncoder().encode('456')); controller.close(); }
  });
  const chunked = new Request('https://mail.skyfirst.io.vn/api/login', {method:'POST',body:stream,duplex:'half'});
  await assert.rejects(() => boundedRequest(chunked, 4), error => error.status === 413);
});

test('gateway transport refuses attachments instead of silently dropping them', async () => {
  await assert.rejects(
    () => sendGateway({MTA_GATEWAY_URL:'https://gateway.example.test/send',MTA_GATEWAY_TOKEN:'test-only'}, {domain:'skyfirst.io.vn'}, {attachments:[{name:'report.pdf'}]}),
    error => error.definitive === true && /chưa hỗ trợ/.test(error.publicMessage)
  );
});

test('folded address headers preserve commas between all recipients and buildMime emits valid related/alternative nesting', async () => {
  const buildMime = mimeBuilderUnderTest();
  const recipients = Array.from({length: 18}, (_, i) => `recipient-${String(i).padStart(2,'0')}@long-example-domain.test`);
  const raw = new TextDecoder().decode(await buildMime({
    from: 'sender@skyfirst.io.vn', to: recipients, subject: 'Recipients', text: 'Test'
  }));
  const header = raw.split('\r\n\r\n', 1)[0];
  const toBlock = header.match(/(?:^To:|\r\nTo:)[\s\S]*?(?=\r\n(?:Cc:|Subject:|Reply-To:|X-Priority:|Importance:|Date:|Message-ID:|MIME-Version:)|$)/)?.[0] || '';
  assert.ok(toBlock.includes('\r\n '), 'long To header should be folded');
  assert.equal((toBlock.match(/recipient-\d{2}@long-example-domain\.test/g)||[]).length, recipients.length);
  assert.equal((toBlock.match(/,/g)||[]).length, recipients.length-1);
});

test('runtime schema bootstrap prepares a clean database and later isolates use the durable marker', async () => {
  const source = read('../src/index.js');
  const start = source.indexOf("const SCHEMA_BOOTSTRAP_VERSION='12.0.5';");
  const end = source.indexOf('\nasync function audit(', start);
  assert.ok(start >= 0 && end > start, 'schema bootstrap source should be independently testable');
  const declaration = source.slice(start, end);
  const createBootstrap = () => new Function('RELIABILITY_STATEMENTS', `${declaration}; return ensureSchema;`)(RELIABILITY_STATEMENTS);
  const raw = database();
  let tablePragmaCount = 0;
  const DB = {
    exec: raw.exec,
    batch: raw.batch,
    prepare(sql) {
      if (/^\s*PRAGMA table_info/i.test(sql)) tablePragmaCount++;
      return raw.prepare(sql);
    }
  };
  await createBootstrap()({ DB });
  assert.equal(tablePragmaCount, 5, 'runtime compatibility checks should perform one PRAGMA per affected table');
  const marker = await DB.prepare("SELECT value_json FROM settings WHERE key='runtime_schema_version'").first();
  assert.equal(marker.value_json, '"12.0.5"');
  const countAfterAssertions = tablePragmaCount;
  await createBootstrap()({ DB });
  assert.equal(tablePragmaCount, countAfterAssertions);
});

test('all 9 D1 migrations execute in order and create the complete 29-table schema', () => {
  const files = readdirSync(atRoot('migrations')).filter(x => /^\d+_.+\.sql$/.test(x)).sort();
  assert.equal(files.length, 9, 'expected nine ordered migrations');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of files) db.exec(readFileSync(atRoot(`migrations/${file}`), 'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
    assert.equal(tables.length, 29);
    for (const required of [
      'users','mailboxes','messages','attachments','sessions','settings','aliases',
      'user_preferences','contacts','signatures','labels','message_labels','mail_rules',
      'notifications','compose_drafts','managed_domains','mail_templates','delivery_events',
      'send_operations','login_limits','inbound_receipts','verification_history',
      'send_delegations','send_queue','message_recalls','suppression_list','security_alerts'
    ]) assert.ok(tables.includes(required), `missing table ${required}`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('governance helpers enforce badge anti-spoofing, executable attachment blocking, risk scoring, and BIMI/DNS evaluation', async () => {
  assert.equal(hasSpoofedBadgeInName('Nguyễn Văn A ✓'), true);
  assert.equal(sanitizeDisplayName('Nguyễn Văn A ✓ [Tích xanh]', false), 'Nguyễn Văn A');
  assert.equal(isDangerousAttachmentName('trojan.pdf.exe'), true);
  assert.equal(isDangerousAttachmentName('report.pdf'), false);

  const risk = assessContentAndRecipientRisk({
    user: { is_verified: 0, created_at: new Date().toISOString() },
    recipients: ['a@test.com'],
    subject: 'Khẩn',
    html: '<a href="http://192.168.1.1/login">https://skyfirst.io.vn</a>',
    attachments: [{ name: 'payload.bat' }]
  });
  assert.equal(risk.level, 'critical');
  assert.ok(risk.score >= 80);

  const mockDns = async (name, type) => {
    if (type === 'MX') return { Answer: [{ data: '10 route1.mx.cloudflare.net.' }] };
    if (name.startsWith('_skyfirst-mail.')) return { Answer: [{ data: '"skyfirst-mail-verification=tok123"' }] };
    if (name.startsWith('resend._domainkey.')) return { Answer: [{ data: '"v=DKIM1; k=rsa; p=ABC"' }] };
    if (name.startsWith('_dmarc.')) return { Answer: [{ data: '"v=DMARC1; p=none"' }] };
    if (name.startsWith('default._bimi.')) return { Answer: [{ data: '"v=BIMI1; l=https://mail.skyfirst.io.vn/bimi-logo.svg"' }] };
    return { Answer: [{ data: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }] };
  };
  const bimiReport = await inspectDomainBimiAndDns({ domain: 'skyfirst.io.vn', verification_token: 'tok123', dkim_selector: 'resend' }, mockDns);
  assert.equal(bimiReport.ownership, true);
  assert.equal(bimiReport.spf.ok, true);
  assert.equal(bimiReport.dkim.ok, true);
  assert.equal(bimiReport.dmarc.bimiEligible, false, 'DMARC p=none must be flagged as not eligible for BIMI');
  assert.equal(bimiReport.externalStatus, 'not_eligible');
});
