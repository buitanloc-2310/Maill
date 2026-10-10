import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

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
  assert.match(ui, /if\(!allowRemote&&\/\^\(\?:https\?\:\)\?\\\/\\\//i);
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
