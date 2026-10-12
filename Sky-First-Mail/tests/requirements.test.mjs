import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { isAllowedAvatarImage, safeAttachmentResponse } from '../src/lib/content-policy.js';
import { boundedRequest } from '../src/lib/reliability.js';
import { sendGateway, sendExternal } from '../src/lib/transport.js';
import { safeMimeType, safeMimeFilename } from '../src/lib/mime-safety.js';
import { readStreamBounded } from '../src/lib/stream-limit.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);
const atRoot = (p) => new URL(p, root);

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

test('email HTML sanitizer blocks active markup, event handlers and encoded script URLs', () => {
  const cleanEmailHtml = sanitizerUnderTest();
  const clean = cleanEmailHtml('<table><tr><td style="color:red">Xin chào</td></tr></table><img src="x" onerror="alert(1)"><svg onload="alert(1)"><script>x</script></svg><a href="jav&#x61;script:alert(1)">click</a><iframe srcdoc="x"></iframe>');
  assert.match(clean, /<table>/i);
  assert.match(clean, /color:red/i);
  assert.doesNotMatch(clean, /onerror|onload|javascript:|<script|<svg|<iframe|srcdoc/i);
});

test('requested compose library ships exactly five HTML documents and ten snippets', () => {
  const catalog = JSON.parse(read('../public/library/compose-library.json'));
  const templates = catalog.templates || [];
  assert.equal(templates.filter(x => x.file && /\.html$/i.test(x.file)).length, 5);
  assert.equal(templates.filter(x => !x.file && x.body_text).length, 10);
  for (const item of templates.filter(x => x.file)) {
    const file = atRoot(item.file.replace(/^\//, 'public/'));
    assert.ok(existsSync(file), `missing HTML template: ${item.file}`);
    const html = readFileSync(file, 'utf8');
    assert.match(html, /<!doctype html/i);
    assert.match(html, /<body[\s>]/i);
  }
});

test('PWA manifest icons exist and static-only service worker excludes API caching', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(existsSync(atRoot(icon.src.replace(/^\//, 'public/'))), `missing ${icon.src}`);
  const sw = read('../public/sw.js');
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /cache: 'no-store'/);
});

test('Windows desktop installer metadata and CI build path are present', () => {
  const desktop = JSON.parse(read('../desktop/package.json'));
  assert.equal(desktop.build.productName, 'Sky First Mail');
  assert.match(desktop.scripts['build:win'], /electron-builder.*nsis.*x64/);
  assert.match(desktop.build.win.artifactName, /Sky-First-Mail-Setup/);
  assert.ok(existsSync(atRoot('public/app-icon.ico')));
  assert.match(read('../desktop/main.cjs'), /contextIsolation: true/);
  assert.match(read('../desktop/main.cjs'), /nodeIntegration: false/);
  assert.match(read('../.github/workflows/build-windows.yml'), /runs-on: windows-latest/);
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

test('external images in received emails require explicit user opt-in', () => {
  const ui = read('../public/app.js');
  assert.match(ui, /function prepareMailHtml\(html,allowRemote=false\)/);
  assert.ok(ui.includes("if(/^(?:https?:)?\\/\\//i.test(src)&&!allowRemote)"), 'remote image loading must require explicit opt-in');
  assert.match(ui, /renderMailFrame\(false\)/);
  assert.match(ui, /renderMailFrame\(true\)/);
  assert.match(ui, /referrerpolicy=\"no-referrer\"/);
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

test('Windows shell hardens the renderer and restricts navigation to its configured origin', () => {
  const main = read('../desktop/main.cjs');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /next\.origin\s*!==\s*trustedOrigin\(\)/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /shell\.openExternal/);
  assert.match(main, /setAppUserModelId\('io\.vn\.skyfirst\.mail'\)/);
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
  const ico = readFileSync(atRoot('public/app-icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO resource type');
  assert.ok(ico.readUInt16LE(4) >= 1, 'ICO must contain at least one icon image');
});


test('bootstrap and admin endpoints enforce server-side security controls', () => {
  const api = read('../src/index.js');
  assert.match(api, /env\.SETUP_SECRET/);
  assert.match(api, /x-setup-secret/);
  assert.match(api, /constantTimeEqual/);
  assert.match(api, /b\.role!=='user'&&user\.role!=='super_admin'/);
  assert.match(api, /target\.role!=='user'&&user\.role!=='super_admin'/);
  assert.match(api, /Only|Chỉ Siêu quản trị viên được quản lý mật khẩu tài khoản quản trị/);
  assert.match(api, /INSERT INTO login_limits/);
  assert.match(api, /retry-after/);
  assert.doesNotMatch(api, /detail:String\(e\?\.message\|\|e\)/);
});

test('email reader validates link schemes and enables authenticated inline image requests', () => {
  const ui = read('../public/app.js');
  assert.match(ui, /noopener noreferrer nofollow/);
  assert.match(ui, /http:\x27,\x27https:\x27,\x27mailto:\x27,\x27tel:\x27/);
  assert.match(ui, /sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"/);
  const api = read('../src/index.js');
  assert.match(api, /cid:/);
  assert.match(api, /attachments\/\$\{i\}\?inline=1/);
});

test('web entry document points to existing local assets only', () => {
  const html = read('../public/index.html');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /src="\/v3\.js"/);
  assert.match(html, /src="\/v4\.js"/);
  assert.match(html, /src="\/v5\.js"/);
  for (const file of ['styles.css','app.js','v3.js','v4.js','v5.js','sw.js','manifest.webmanifest','sky-first-logo.png','favicon-app.png','app-icon-192.png']) {
    assert.ok(existsSync(atRoot(`public/${file}`)), `missing referenced static asset: ${file}`);
  }
});


test('session expiry is compared as a parsed timestamp, not lexicographic text', () => {
  const auth = read('../src/lib/auth.js');
  assert.match(auth, /datetime\(s\.expires_at\)>datetime\('now'\)/);
  assert.doesNotMatch(auth, /s\.expires_at>CURRENT_TIMESTAMP/);
});

test('bootstrap setup claim is atomic and rolls back only if no active root exists', () => {
  const api = read('../src/index.js');
  assert.match(api, /UPDATE settings SET value_json='\"initializing\"'.*WHERE key='setup_completed' AND value_json='false'/);
  assert.match(api, /claim\.meta\?\.changes/);
  assert.match(api, /if\(!root\).*value_json='false'/s);
});

test('account deletion preserves shared R2 objects and removes owned messages and send operations', () => {
  const api = read('../src/index.js');
  assert.match(api, /deleteObjectIfUnreferenced/);
  assert.match(api, /SELECT 1 FROM messages WHERE storage_key=\?.*UNION ALL SELECT 1 FROM attachments WHERE storage_key=\?/s);
  assert.match(api, /DELETE FROM messages WHERE mailbox_id IN \(SELECT id FROM mailboxes WHERE user_id=\?\)/);
  assert.match(api, /DELETE FROM send_operations WHERE user_id=\?/);
});

test('avatar uploads reject SVG and require raster signatures', () => {
  const api = read('../src/index.js');
  assert.match(api, /isAllowedAvatarImage\(type,bytes\)/);
  assert.doesNotMatch(api, /file\.type\|\|''\)\.startsWith\('image\/'/);
  const policy = read('../src/lib/content-policy.js');
  assert.match(policy, /image\/png/);
  assert.match(policy, /image\/jpeg/);
  assert.match(policy, /image\/gif/);
  assert.match(policy, /image\/webp/);
});

test('admin PATCH cannot elevate regular users and last active Super Admin is protected', () => {
  const api = read('../src/index.js');
  assert.match(api, /user\.role!=='super_admin'&&b\.role!==target\.role&&b\.role!=='user/);
  assert.match(api, /willBeRoot/);
  assert.match(api, /role='super_admin' AND status='active' AND \(SELECT count\(\*\) FROM users WHERE role='super_admin' AND status='active'\)>1/);
});

test('desktop opens safe mail and telephone links through the OS handler', () => {
  const main = read('../desktop/main.cjs');
  assert.match(main, /new Set\(\['https:', 'http:', 'mailto:', 'tel:'\]\)/);
  assert.match(main, /externalProtocols\.has\(next\.protocol\)/);
});


test('inbound delivery normalizes RFC date, enforces domain receive switch, and uses atomic receipt dedupe', () => {
  const api = read('../src/index.js');
  assert.match(api, /function normalizeMessageDate\(value\)/);
  assert.match(api, /const sentAt = normalizeMessageDate\(message\.headers\.get\('date'\)\)/);
  assert.match(api, /SELECT receive_enabled,status FROM managed_domains WHERE lower\(domain\)=lower\(\?\)/);
  assert.match(api, /INSERT OR IGNORE INTO inbound_receipts\(mailbox_id,digest\)/);
  assert.match(api, /WHERE changes\(\)=1/);
  assert.match(api, /DELETE FROM inbound_receipts WHERE created_at<datetime\('now','-30 days'\)/);
  assert.match(api, /if\(storageKey\)await deleteObjectIfUnreferenced\(env,storageKey\)/);
});

test('mail rules can only target owned mailboxes and folders supported by inbound processing', () => {
  const api = read('../src/index.js');
  assert.match(api, /if\(mailboxId!==null&&\(!Number\.isSafeInteger\(mailboxId\).*ownsMailbox\(env,user\.id,mailboxId\)\)\)return badRequest\('Mailbox trong quy tắc không hợp lệ\.'/s);
  assert.match(api, /const folder=\['inbox','spam','trash'\]\.includes\(b\.actionFolder\)\?b\.actionFolder:null/);
});

test('draft save validates existing records before R2 writes and preserves attachment names when unchanged', () => {
  const api = read('../src/index.js');
  assert.ok(api.indexOf("const old=id?await env.DB.prepare(`SELECT storage_key,attachment_names_json FROM compose_drafts") < api.indexOf('await env.MAIL_STORAGE.put(storageKey,raw'));
  assert.match(api, /namesExpr=\(replaceAttachments\|\|storageKey\)\?'\?':'attachment_names_json'/);
  assert.match(api, /if\(storageKey\)await deleteObjectIfUnreferenced\(env,storageKey\)/);
  assert.match(api, /deleteObjectIfUnreferenced\(env,old\.storage_key\)/);
});

test('account deletion executes dependent row removals in one database batch before auditing and R2 cleanup', () => {
  const api = read('../src/index.js');
  const start = api.indexOf('// Keep database deletion atomic:');
  const end = api.indexOf("return json({ok:true,deleted:true})", start);
  const block = api.slice(start, end);
  assert.match(block, /await env\.DB\.batch\(\[/);
  assert.match(block, /DELETE FROM messages WHERE mailbox_id IN/);
  assert.match(block, /DELETE FROM send_operations WHERE user_id=\?/);
  assert.match(block, /DELETE FROM users WHERE id=\?/);
  assert.ok(block.indexOf('await env.DB.batch') < block.indexOf("await audit(env,user.id,'admin.user.deleted'"));
});

test('inline attachments only render verified raster images; active content is forced to download', async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.equal(isAllowedAvatarImage('image/png', png), true);
  assert.equal(isAllowedAvatarImage('image/svg+xml', new TextEncoder().encode('<svg/>')), false);
  assert.equal(isAllowedAvatarImage('image/png', new TextEncoder().encode('<html>')), false);

  const safe = safeAttachmentResponse({filename:'photo.png',mimeType:'image/png',content:png}, true);
  assert.equal(safe.headers.get('content-type'), 'image/png');
  assert.match(safe.headers.get('content-disposition'), /^inline;/);
  assert.equal(safe.headers.get('x-content-type-options'), 'nosniff');

  const hostile = safeAttachmentResponse({filename:'../../evil\r\nX-Bad: yes.svg',mimeType:'image/svg+xml',content:new TextEncoder().encode('<svg onload="alert(1)"/>')}, true);
  assert.equal(hostile.headers.get('content-type'), 'application/octet-stream');
  assert.match(hostile.headers.get('content-disposition'), /^attachment;/);
  assert.doesNotMatch(hostile.headers.get('content-disposition'), /\r|\n|\.\./);
  assert.match(hostile.headers.get('content-security-policy'), /sandbox/);

  const international = safeAttachmentResponse({filename:'tệp đính kèm – bản cuối.png',mimeType:'application/octet-stream',content:png}, false);
  const contentDisposition = international.headers.get('content-disposition');
  assert.match(contentDisposition, /filename\*=UTF-8''/);
  assert.doesNotMatch(contentDisposition, /[^\x00-\x7f]/, 'header must remain byte-safe for Vietnamese filenames');

  const downloaded = safeAttachmentResponse({filename:'document.html',mimeType:'text/html',content:new TextEncoder().encode('<script>bad</script>')}, false);
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
});

test('API request bodies are bounded even without a trustworthy Content-Length header', async () => {
  const api = read('../src/index.js');
  assert.match(api, /request=await boundedRequest\(request,bodyLimit\)/);
  assert.match(api, /url\.pathname==='\/api\/compose'\|\|url\.pathname==='\/api\/drafts'\?16\*1024\*1024/);
  assert.match(api, /url\.pathname==='\/api\/templates'\?2\*1024\*1024/);
  assert.match(api, /Nội dung yêu cầu vượt quá giới hạn cho phép/);

  const tooLargeHeader = new Request('https://mail.test/api/login', {
    method: 'POST', headers: {'content-length':'9'}, body: 'x'
  });
  await assert.rejects(() => boundedRequest(tooLargeHeader, 4), error => error.status === 413);

  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('123')); controller.enqueue(new TextEncoder().encode('456')); controller.close(); }
  });
  const chunked = new Request('https://mail.test/api/login', {method:'POST',body:stream,duplex:'half'});
  await assert.rejects(() => boundedRequest(chunked, 4), error => error.status === 413);
});

test('message pagination rejects malformed cursors and clamps query size and page length', () => {
  const api = read('../src/index.js');
  assert.match(api, /if\(!Number\.isSafeInteger\(mailboxId\)\|\|mailboxId<0\)return badRequest/);
  assert.match(api, /\.slice\(0,200\)/);
  assert.match(api, /Math\.floor\(Math\.min\(100,Math\.max\(1,limitRaw\)\)\)/);
  assert.match(api, /if\(!Number\.isSafeInteger\(beforeRaw\)\|\|beforeRaw<0\)return badRequest/);
});

test('legacy avatars are revalidated before being served on the application origin', () => {
  const api = read('../src/index.js');
  assert.match(api, /const originalType=String\(o\.httpMetadata\?\.contentType\|\|''\)/);
  assert.match(api, /if\(!isAllowedAvatarImage\(originalType,bytes\)\)return notFound/);
  assert.match(api, /'content-security-policy':"default-src 'none'; sandbox/);
});

test('gateway transport refuses attachments instead of silently dropping them', async () => {
  const transport = read('../src/lib/transport.js');
  assert.match(transport, /MTA gateway hiện chưa hỗ trợ tệp đính kèm hoặc ảnh nội tuyến/);
  assert.match(transport, /publicMessage/);
  await assert.rejects(
    () => sendGateway({MTA_GATEWAY_URL:'https://gateway.example.test/send',MTA_GATEWAY_TOKEN:'test-only'}, {domain:'skyfirst.io.vn'}, {attachments:[{name:'report.pdf'}]}),
    error => error.definitive === true && /chưa hỗ trợ/.test(error.publicMessage)
  );
  await assert.rejects(
    () => sendGateway({MTA_GATEWAY_URL:'https://gateway.example.test/send',MTA_GATEWAY_TOKEN:'test-only'}, {domain:'skyfirst.io.vn'}, {inlineAttachments:[{name:'logo.png'}]}),
    error => error.definitive === true
  );
});

test('MIME headers reject injected media types and encode unsafe or international filenames', () => {
  assert.equal(safeMimeType('image/png'), 'image/png');
  assert.equal(safeMimeType('image/png\r\nBcc: victim@example.test'), 'application/octet-stream');
  assert.equal(safeMimeType('image/svg+xml; charset=utf-8'), 'image/svg+xml');
  const filename = safeMimeFilename('../../báo cáo";\r\nBcc: x.txt');
  assert.doesNotMatch(filename.ascii, /[^\x20-\x7e]|\r|\n|\.\.|[";]/);
  assert.match(filename.parameters, /filename\*=UTF-8''/);
  assert.doesNotMatch(filename.parameters, /\r|\n/);
  const mail = read('../src/lib/mail.js');
  assert.match(mail, /const mime=safeMimeType\(a\.type\),filename=safeMimeFilename/);
  assert.match(mail, /inlineCidMap\[index\]\?\.cid/);
  assert.match(mail, /multipart\/related/);
  assert.match(mail, /encodeHeaderText/);
});

test('admin account creation is an atomic database batch and inputs have hard upper bounds', () => {
  const api = read('../src/index.js');
  const start = api.indexOf("if(path==='/api/admin/users'&&request.method==='POST'){");
  const end = api.indexOf('const aum=path.match', start);
  const block = api.slice(start, end);
  assert.match(block, /await env\.DB\.batch\(\[/);
  assert.match(block, /INSERT INTO users/);
  assert.match(block, /INSERT INTO mailboxes\(user_id,address,display_name,is_primary,is_active\) SELECT id/);
  assert.match(block, /INSERT OR IGNORE INTO user_preferences\(user_id\) SELECT id/);
  assert.match(api, /String\(v\|\|''\)\.length<=254/);
  assert.match(api, /password\.length>1024/);
  const compose = read('../src/lib/compose.js');
  assert.match(compose, /String\(value\|\|''\)\.length<=254/);
});

test('Chromium browser smoke is dependency-free, exercises real frontend with mock API, and checks mobile overflow', () => {
  const localServer = read('../scripts/local-server.mjs');
  const smoke = read('../scripts/browser-smoke.cjs');
  const pkg = JSON.parse(read('../package.json'));
  const match = localServer.match(/SETUP_SECRET:'([^']+)'/);
  assert.ok(match && match[1].length >= 24, 'local test secret must meet bootstrap minimum length');
  assert.match(smoke, /\[name=setupSecret\]/);
  assert.match(smoke, /Emulation\.setDeviceMetricsOverride/);
  assert.match(smoke, /Horizontal overflow at 390px/);
  assert.match(smoke, /isolated mock API/);
  assert.doesNotMatch(smoke, /require\(['"]playwright['"]\)/, 'browser smoke must not rely on undeclared Playwright');
  assert.match(pkg.scripts['test:composer-sanitizer'], /node scripts\/composer-sanitizer-smoke\.cjs/);
  assert.match(pkg.scripts['test:browser'], /npm run test:composer-sanitizer && node scripts\/browser-smoke\.cjs/);
  assert.doesNotMatch(localServer, /#setup=[^; ]{24,}/, 'test key must not be put into the URL');
});

test('live cross-provider smoke test requires explicit opt-in and never logs session cookies', () => {
  const live = read('../scripts/live-mail-smoke.mjs');
  assert.match(live, /SEND_ONE_LIVE_TEST_EMAIL/);
  assert.match(live, /MAIL_SMOKE_ALLOW_PRODUCTION === 'YES'/);
  assert.match(live, /MAIL_SMOKE_SESSION_COOKIE/);
  assert.match(live, /No email was sent/);
  assert.doesNotMatch(live, /console\.(?:log|error)\([^\n]*cookie/i);
  assert.match(live, /Recipient must be on a different provider\/domain to test cross-provider delivery\. No email was sent/);
});

test('CI runs integrated mail tests, desktop/mobile browser smoke, and verifies a Windows installer checksum', () => {
  const workflow = read('../.github/workflows/build-windows.yml');
  const pkg = JSON.parse(read('../package.json'));
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run test:browser/);
  assert.match(workflow, /npm run test:mobile/);
  assert.equal(pkg.scripts['test:mobile'], 'node scripts/mobile-layout-smoke.cjs');
  assert.match(workflow, /sky-first-mail-mobile-smoke/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /npm run build:win/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/);
  assert.match(workflow, /sky-first-mail-windows-installer/);
});

test('client email renderer removes active elements and unsafe attributes before srcdoc', () => {
  const ui = read('../public/app.js');
  const start = ui.indexOf('function prepareMailHtml(');
  const end = ui.indexOf('\nasync function openMessage(', start);
  assert.ok(start >= 0 && end > start, 'prepareMailHtml should be a standalone helper');
  const helper = ui.slice(start, end);
  for (const element of ['script','iframe','object','embed','form','svg','math','portal']) {
    assert.ok(helper.includes(element), `renderer should remove ${element}`);
  }
  assert.match(helper, /name\.startsWith\('on'\)/);
  assert.match(helper, /srcdoc/);
  assert.match(helper, /@import\|url/);
  assert.match(helper, /noopener noreferrer nofollow/);
  assert.match(helper, /sfmRemoteSrc/);
});

test('admin service status reports configured domains rather than hard-coding receive as healthy', () => {
  const api = read('../src/index.js');
  const start = api.indexOf("if(path==='/api/admin/system'&&request.method==='GET'){");
  const end = api.indexOf("if(path==='/api/admin/users'&&request.method==='GET')", start);
  const block = api.slice(start, end);
  assert.match(block, /receivingConfigured/);
  assert.match(block, /receivingEnabledDomains/);
  assert.match(block, /transportReady/);
  assert.doesNotMatch(block, /receiving:true/);
});

test('received email iframe has CSP that blocks script and outbound loads unless images are enabled', () => {
  const ui = read('../public/app.js');
  assert.match(ui, /http-equiv="Content-Security-Policy"/);
  assert.match(ui, /default-src 'none'/);
  assert.match(ui, /img-src \$\{imagePolicy\}/);
  assert.match(ui, /script-src 'none'/);
  assert.match(ui, /connect-src 'none'/);
  assert.match(ui, /const imagePolicy=allowRemote\?/);
});

test('R2 cleanup separates reference-check failures from storage deletion failures', () => {
  const api = read('../src/index.js');
  const start = api.indexOf('async function deleteObjectIfUnreferenced');
  const end = api.indexOf('\nasync function resolveSenderIdentity', start);
  const helper = api.slice(start, end);
  assert.match(helper, /STORAGE_DELETE_SKIPPED_REFERENCE_CHECK_FAILED/);
  assert.match(helper, /STORAGE_DELETE_FAILED/);
  assert.match(helper, /if\(reference\)return false/);
});


test('inline CID mapping is ordinal, unique, bounded, and never inferred by duplicate filename', () => {
  const compose = read('../src/lib/compose.js');
  const transport = read('../src/lib/transport.js');
  const mail = read('../src/lib/mail.js');
  assert.match(compose, /inlineCidMap\.length!==inlineAttachments\.length/);
  assert.match(compose, /new Set\(inlineCidMap\.map\(x=>x\.cid\)\)/);
  assert.match(transport, /m\.inlineCidMap\?\.\[index\]\?\.cid/);
  assert.doesNotMatch(transport, /find\(x=>x\.name===a\.name\)/);
  assert.match(mail, /multipart\/related/);
  assert.match(mail, /Content-ID: <\$\{cid\}>/);
});

test('domain ownership verification requires exact TXT token and legacy domains can mint a token', () => {
  const api = read('../src/index.js');
  assert.match(api, /txtValues\.some\(x=>x===token\)/);
  assert.doesNotMatch(api, /txtValues\.some\(x=>x\.includes\(token\)\)/);
  assert.match(api, /if\(!domain\.verification_token\).*verification_token=\?/s);
  assert.match(api, /requiredRecord/);
});

test('admin domain UI exposes TXT record, verification and DNS health checks', () => {
  const ui = read('../public/app.js');
  assert.match(ui, /data-domain-verify/);
  assert.match(ui, /data-domain-health/);
  assert.match(ui, /skyfirst-mail-verification=/);
  assert.match(ui, /MX: \$\{result\.health\.mx/);
});

test('admin peers cannot edit, reset, or delete administrator accounts', () => {
  const api = read('../src/index.js');
  assert.ok((api.match(/target\.role!=='user'&&user\.role!=='super_admin'/g)||[]).length >= 3);
  assert.match(api, /Only|Chỉ Siêu quản trị viên được sửa tài khoản quản trị/);
  assert.match(api, /Only|Chỉ Siêu quản trị viên được xóa tài khoản quản trị/);
  assert.match(api, /Only|Chỉ Siêu quản trị viên được quản lý mật khẩu tài khoản quản trị/);
});

test('account removal guards dependent deletes and final Super Admin deletion in SQL', () => {
  const api = read('../src/index.js');
  assert.match(api, /EXISTS \(SELECT 1 FROM users WHERE id=\? AND \$\{canDeleteSql\}\)/);
  assert.match(api, /DELETE FROM users WHERE id=\? AND \$\{canDeleteSql\}/);
  assert.match(api, /results\?\.\[2\]\?\.meta\?\.changes/);
});

test('R2 cleanup retains objects referenced by a send operation', () => {
  const api = read('../src/index.js');
  assert.match(api, /SELECT 1 FROM send_operations WHERE storage_key=\?/);
});

test('inbound message body is stream-limited before whole-message buffering', async () => {
  const bytes = new TextEncoder().encode('small email');
  const stream = new ReadableStream({start(c){c.enqueue(bytes);c.close();}});
  const result = await readStreamBounded(stream, 100);
  assert.equal(new TextDecoder().decode(result), 'small email');
  let cancelled = false;
  const tooLarge = new ReadableStream({
    pull(c){c.enqueue(new Uint8Array(8));},
    cancel(){cancelled = true;}
  });
  await assert.rejects(() => readStreamBounded(tooLarge, 7), error => error.status === 413);
  assert.equal(cancelled, true);
});

test('MIME subject UTF-8 gets encoded and header folding protects long recipient lists', () => {
  const mail = read('../src/lib/mail.js');
  assert.match(mail, /encodeHeaderText/);
  assert.match(mail, /\?UTF-8\?B\?/);
  assert.match(mail, /foldAddressHeader\('To', to\)/);
  assert.match(mail, /foldAddressHeader\('Cc',cc\)/);
  assert.doesNotMatch(mail, /`Bcc: \$\{bcc\.map/);
});


test('folded address headers preserve commas between all recipients', async () => {
  const buildMime = mimeBuilderUnderTest();
  const recipients = Array.from({length: 18}, (_, i) => `recipient-${String(i).padStart(2,'0')}@long-example-domain.test`);
  const raw = new TextDecoder().decode(await buildMime({
    from: 'sender@skyfirst.io.vn', to: recipients, subject: 'Recipients', text: 'Test'
  }));
  const header = raw.split('\r\n\r\n', 1)[0];
  const toBlock = header.match(/(?:^To:|\r\nTo:)[\s\S]*?(?=\r\n(?:Cc:|Subject:|Reply-To:|X-Priority:|Importance:|Date:|Message-ID:|MIME-Version:)|$)/)?.[0] || '';
  assert.ok(toBlock.includes('\r\n '), 'long To header should be folded');
  assert.equal((toBlock.match(/recipient-\d{2}@long-example-domain\.test/g)||[]).length, recipients.length);
  assert.equal((toBlock.match(/,/g)||[]).length, recipients.length-1, 'folding must not discard address separators');
});

test('production MIME builder emits valid related/alternative nesting, distinct CIDs and no Bcc header', async () => {
  const buildMime = mimeBuilderUnderTest();
  const file = (name, type, bytes) => Object.assign(new Blob([bytes], {type}), {name});
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
  const raw = new TextDecoder().decode(await buildMime({
    from: 'sender@skyfirst.io.vn', to: ['one@example.test'], cc: ['two@example.test'],
    bcc: ['blind@example.test'], subject: 'Xin chào – Sky First', text: 'Nội dung',
    html: '<p>Xin chào<img src="cid:logo-one"><img src="cid:logo-two"></p>',
    inlineAttachments: [file('logo.png','image/png',png), file('logo.png','image/png',png)],
    inlineCidMap: [{name:'logo.png',cid:'logo-one'},{name:'logo.png',cid:'logo-two'}],
    attachments: [file('logo.png','image/png',png)]
  }));
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: multipart\/related/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-ID: <logo-one>/);
  assert.match(raw, /Content-ID: <logo-two>/);
  assert.doesNotMatch(raw, /Bcc: blind@example\.test/i);
  assert.equal((raw.match(/Content-Disposition: inline;/g)||[]).length, 2);
  assert.equal((raw.match(/Content-Disposition: attachment;/g)||[]).length, 1);
});

test('providers cannot silently report success without a provider message ID', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', {status:200,headers:{'content-type':'application/json'}});
    await assert.rejects(
      () => sendExternal({RESEND_API_KEY:'test-only'}, {transport:'resend'}, {fromAddress:'sender@example.test',to:['recipient@example.test'],subject:'test',idempotencyKey:'test-id'}),
      error => error.definitive === false && /without a message ID/.test(error.message)
    );
    await assert.rejects(
      () => sendGateway({MTA_GATEWAY_URL:'https://gateway.example.test/send',MTA_GATEWAY_TOKEN:'test-only'}, {domain:'example.test'}, {fromAddress:'sender@example.test',to:['recipient@example.test'],subject:'test',idempotencyKey:'test-id'}),
      error => error.definitive === false && /without a message ID/.test(error.message)
    );
    globalThis.fetch = async () => new Response('{"id":"email-123"}', {status:200,headers:{'content-type':'application/json'}});
    assert.deepEqual(await sendExternal({RESEND_API_KEY:'test-only'}, {transport:'resend'}, {fromAddress:'sender@example.test',to:['recipient@example.test'],subject:'test',idempotencyKey:'test-id'}), {id:'email-123',provider:'resend'});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inline image payloads must match their declared raster format on send and draft save', () => {
  const compose = read('../src/lib/compose.js');
  const api = read('../src/index.js');
  assert.match(compose, /isAllowedAvatarImage\(a\.type,new Uint8Array\(await a\.arrayBuffer\(\)\)\)/);
  assert.match(api, /isAllowedAvatarImage\(a\.type,new Uint8Array\(await a\.arrayBuffer\(\)\)\)/);
  assert.match(api, /inlineCidMap\.length!==inlineAttachments\.length/);
});


test('schema bootstrap is single-flight for concurrent first requests in a Worker isolate', () => {
  const api = read('../src/index.js');
  assert.match(api, /let schemaReady=false,schemaPromise=null/);
  assert.match(api, /if\(schemaPromise\)return schemaPromise/);
  assert.match(api, /schemaPromise=\(async\(\)=>\{/);
  assert.match(api, /schemaPromise=null;\s*throw error/s);
});


test('mixed internal and external recipients cannot trigger a fallback send to local To recipients', () => {
  const compose = read('../src/lib/compose.js');
  assert.match(compose, /domain\.transport\|\|'resend'\)\.toLowerCase\(\)==='resend'&&!external\('to'\)\.length/);
  assert.match(compose, /to:external\('to'\),cc:external\('cc'\),bcc:external\('bcc'\)/);
  assert.doesNotMatch(compose, /to:external\('to'\)\.length\?external\('to'\):to/);
});


test('contact and directory query input has explicit size bounds', () => {
  const api = read('../src/index.js');
  assert.ok(api.includes("url.searchParams.get('q')||'').trim().slice(0,120)"));
  assert.match(api, /name\.length>120\|\|notes\.length>2000/);
  assert.match(api, /ghi chú tối đa 2\.000 ký tự/);
});


test('all D1 migrations execute in order and create the complete 23-table schema', () => {
  const files = readdirSync(atRoot('migrations')).filter(x => /^\d+_.+\.sql$/.test(x)).sort();
  assert.equal(files.length, 8, 'expected eight ordered migrations');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of files) db.exec(readFileSync(atRoot(`migrations/${file}`), 'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
    assert.equal(tables.length, 23);
    for (const required of ['users','mailboxes','messages','attachments','sessions','settings','aliases','user_preferences','contacts','signatures','labels','message_labels','mail_rules','notifications','compose_drafts','managed_domains','mail_templates','delivery_events','send_operations','login_limits','inbound_receipts']) assert.ok(tables.includes(required), `missing table ${required}`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('inbound receiving explicitly rejects unconfigured domains before storage', () => {
  const api = read('../src/index.js');
  assert.match(api, /if\(!managedDomain\|\|Number\(managedDomain\.receive_enabled\)!==1\|\|managedDomain\.status==='disabled'\)\{message\.setReject/);
  assert.ok(api.indexOf("if(!managedDomain||Number(managedDomain.receive_enabled)!==1") < api.indexOf('MAIL_STORAGE.put(storageKey,rawEmail'));
});


test('malformed Unicode filenames cannot crash MIME or attachment response generation', () => {
  const malformed = String.fromCharCode(0xd800) + 'report.txt';
  const mimeName = safeMimeFilename(malformed);
  assert.doesNotMatch(mimeName.parameters, /\uD800/);
  assert.match(mimeName.parameters, /filename\*=UTF-8''/);
  const response = safeAttachmentResponse({filename:malformed,mimeType:'text/plain',content:new TextEncoder().encode('ok')}, false);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
});

test('bounded API body reader releases the request stream lock after reading or rejection', async () => {
  const bounded = read('../src/lib/reliability.js');
  assert.match(bounded, /finally\{try\{reader\.releaseLock\(\)\}catch\{\}\}/);
  assert.match(bounded, /catch\(error\)\{try\{await reader\.cancel\(error\)\}catch\{\}throw error\}/);
});


test('mobile navigation exposes four primary destinations and a dedicated More menu for secondary tools', () => {
  const css = read('../public/styles.css');
  const ui = read('../public/app.js');
  const mobileCss = css.slice(css.lastIndexOf('/* ===== R6 mobile webmail usability pass ===== */'));
  assert.ok(mobileCss.length > 0, 'R6 mobile usability stylesheet should be present');
  assert.match(ui, /id=\"mobileMore\"/);
  assert.match(ui, /function mobileMore\(\)/);
  for (const key of ['snoozed', 'archive', 'spam', 'trash']) assert.match(ui, new RegExp(`\\['${key}'`));
  assert.match(ui, /data-mobile-action=\"contacts\"|\$\{tools\.map/);
  assert.match(mobileCss, /@media\(max-width:680px\)/);
  assert.match(mobileCss, /data-folder=\"snoozed\"[\s\S]*?display:none!important/);
  assert.match(mobileCss, /workspace>aside>\.mobile-more\{display:flex!important/);
  assert.match(mobileCss, /env\(safe-area-inset-bottom\)/);
  assert.match(mobileCss, /data-folder=\"inbox\"\]::after\{content:\"Thư đến\"\}/);
  assert.match(mobileCss, /\.workspace>aside>\.mobile-more::after\{content:\"Thêm\";/);
  assert.match(mobileCss, /v7-compose-page \.v5-editor-stage/);
});



test('mobile E2E smoke runs actual frontend scripts in Chromium without navigating to a network origin', () => {
  const smoke = read('../scripts/mobile-layout-smoke.cjs');
  assert.match(smoke, /public\/styles\.css/);
  assert.match(smoke, /public\/app\.js/);
  assert.match(smoke, /public\/v3\.js/);
  assert.match(smoke, /public\/v4\.js/);
  assert.match(smoke, /public\/v5\.js/);
  assert.match(smoke, /about:blank/);
  assert.match(smoke, /\[\[320,740\],\[360,800\],\[390,844\],\[430,932\],\[768,1024\],\[844,390\],\[932,430\],\[1440,1000\]\]/);
  assert.match(smoke, /composerViewports/);
  assert.match(smoke, /Secondary folder menu navigation failed/);
  assert.match(smoke, /Reader overlaps mobile nav/);
});

test('Mail Studio sanitizes HTML at every import, editor, preview, signature, draft and send boundary', () => {
  const ui = read('../public/v5.js');
  assert.match(ui, /const strip=html=>\{const tpl=document\.createElement\('template'\);tpl\.innerHTML=String\(html\|\|''\)/);
  assert.doesNotMatch(ui, /const strip=html=>\{const d=document\.createElement\('div'\);d\.innerHTML/);
  assert.match(ui, /function sanitizeComposerHtml\(html=''\)/);
  assert.match(ui, /function sanitizeClipboardHtml\(html=''\)\{return sanitizeComposerHtml\(html\)\}/);
  assert.match(ui, /source\.value=sanitizeComposerHtml\(seed\.html\|\|esc\(seed\.text\|\|''\)/);
  assert.match(ui, /const syncFromVisual=\(\)=>\{const safe=sanitizeComposerHtml\(visual\.innerHTML\)/);
  assert.match(ui, /const syncFromSource=\(\)=>\{const safe=sanitizeComposerHtml\(source\.value\)/);
  assert.match(ui, /const safeBody=sanitizeComposerHtml\(mode==='html'\?source\.value:visual\.innerHTML\)/);
  assert.match(ui, /fd\.set\('html',safeBody\)/);
  assert.match(ui, /sanitizeComposerHtml\(sg\.content_html\|\|''\)/);
  assert.match(ui, /const renderPreview=\(\)=>\{if\(mode==='visual'\)syncFromVisual\(\);else syncFromSource\(\);const safeBody=sanitizeComposerHtml\(source\.value\)/);
  assert.doesNotMatch(ui, /visual\.innerHTML=seed\.html|visual\.innerHTML=source\.value\s*;\s*source\.value=visual\.innerHTML/);
  assert.match(ui, /const blocked=new Set\(\['SCRIPT','STYLE','IFRAME'/);
  assert.match(ui, /const styleProps=new Set\(/);
  assert.match(ui, /setAttribute\('rel','noopener noreferrer'\)/);
  const legacy = read('../public/v7.js');
  assert.match(legacy, /window\.SkyFirstSanitizeHtml/);
  assert.match(legacy, /html=sanitize\(html\);\$\('#v5-source',f\)\.value=html;\$\('#v5-visual',f\)\.innerHTML=html/);
});


test('Mail Studio status messages stay in the composer flow and are announced accessibly', () => {
  const ui = read('../public/v5.js');
  const css = read('../public/styles.css');
  assert.match(ui, /const inline=\$\('\.v5-wrap \.v5-compose #v5-msg'\)/);
  assert.match(ui, /inline\.setAttribute\('role','status'\)/);
  assert.match(ui, /inline\.setAttribute\('aria-live','polite'\)/);
  assert.match(ui, /box\.replaceChildren\(\)/);
  assert.match(css, /\.v5-compose #v5-msg:empty\{display:none\}/);
  assert.match(css, /\.v5-compose \.v5-inline-message\.err/);
});

test('Chromium sanitizer smoke is wired into browser test and protects URL/CSS paths', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.match(pkg.scripts['test:composer-sanitizer'], /composer-sanitizer-smoke\.cjs/);
  assert.match(pkg.scripts['validate'], /node --check scripts\/composer-sanitizer-smoke\.cjs/);
  const smoke = read('../scripts/composer-sanitizer-smoke.cjs');
  assert.match(smoke, /actual Chromium DOMParser/);
  assert.match(smoke, /blockedActiveMarkup/);
  assert.match(smoke, /rejectedUnsafeUrls/);
  assert.match(smoke, /rejectedSvgDataImage/);
  assert.match(smoke, /removedUnsafeCss/);
  assert.match(smoke, /builtInTemplates/);
  assert.match(smoke, /after.length>=before.length\*0.95/);
});
