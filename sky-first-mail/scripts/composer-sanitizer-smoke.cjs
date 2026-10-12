'use strict';

// Executes the actual composer sanitizer in Chromium without navigating to a
// network URL. This remains usable in environments that block localhost pages.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(p => fs.existsSync(p));
const SOURCE = path.resolve(__dirname, '../public/v5.js');

async function command(ws, method, params = {}) {
  const id = ++command.nextId;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { command.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); }, 5000);
    command.pending.set(id, { resolve, reject, timeout, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
command.nextId = 0;
command.pending = new Map();

async function main() {
  if (!CHROME) throw new Error('Chromium/Chrome not found; set CHROMIUM_PATH to a browser executable');
  const source = await fsp.readFile(SOURCE, 'utf8');
  const catalog = JSON.parse(await fsp.readFile(path.resolve(__dirname, '../public/library/compose-library.json'), 'utf8'));
  const builtinTemplates = await Promise.all((catalog.templates || []).filter(t => t.file).map(async t => ({ name: t.name, html: await fsp.readFile(path.resolve(__dirname, '../public', t.file.replace(/^\/+/, '')), 'utf8') })));
  const start = source.indexOf('  function sanitizeComposerHtml(html=\'\'){');
  const end = source.indexOf('  function sanitizeClipboardHtml(html=\'\')', start);
  if (start < 0 || end <= start) throw new Error('Cannot locate composer sanitizer in public/v5.js');
  const sanitizer = source.slice(start, end).trim();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfm-sanitizer-chrome-'));
  let chrome, ws;
  try {
    chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 3000) stderr = stderr.slice(-3000); });
    const active = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 12000;
    let port = 0;
    while (Date.now() < deadline && chrome.exitCode === null) {
      try { port = Number((await fsp.readFile(active, 'utf8')).split(/\r?\n/)[0]); if (port) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!port) throw new Error(`Chromium remote debugging failed to start. ${stderr}`);
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!targetResponse.ok) throw new Error(`Could not create about:blank target: HTTP ${targetResponse.status}`);
    const target = await targetResponse.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out connecting to Chromium DevTools')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('Chromium DevTools WebSocket connection failed')); }, { once: true });
    });
    ws.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (!packet.id) return;
      const pending = command.pending.get(packet.id);
      if (!pending) return;
      command.pending.delete(packet.id); clearTimeout(pending.timeout);
      if (packet.error) pending.reject(new Error(`${pending.method}: ${packet.error.message}`));
      else pending.resolve(packet.result || {});
    });
    await command(ws, 'Runtime.enable');
    const attack = '<p style="color:#123456;font-size:18px">Safe formatting</p>' +
      '<img src="x" onerror="globalThis.__sfmXss=1">' +
      '<svg onload="globalThis.__sfmXss=2"><script>globalThis.__sfmXss=3</script></svg>' +
      '<iframe srcdoc="&lt;script&gt;globalThis.__sfmXss=4&lt;/script&gt;"></iframe>' +
      '<a href="jav&#x61;script:globalThis.__sfmXss=5">bad link</a>' +
      '<a href="https://example.com/path" onclick="globalThis.__sfmXss=6">safe link</a>' +
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" onload="x">' +
      '<table><tr><td bgcolor="#ffffff" style="padding:8px;border:1px solid #ddd">table</td></tr></table>' +
      '<div style="background-image:url(javascript:alert(1));color:red">CSS</div>';
    const expression = `(()=>{${sanitizer};const out=sanitizeComposerHtml(${JSON.stringify(attack)});const doc=new DOMParser().parseFromString(out,'text/html');const all=[...doc.querySelectorAll('*')];const templates=JSON.parse(${JSON.stringify(JSON.stringify(builtinTemplates))});const templateChecks=templates.map(t=>{const before=new DOMParser().parseFromString(t.html,'text/html').body.textContent.replace(/\\s+/g,' ').trim();const clean=sanitizeComposerHtml(t.html);const after=new DOMParser().parseFromString(clean,'text/html').body.textContent.replace(/\\s+/g,' ').trim();return {name:t.name,ok:after.length>0&&after.length>=before.length*0.95&& !/<(?:script|iframe|svg)\\b/i.test(clean),beforeLength:before.length,afterLength:after.length}});return {html:out,script:!!doc.querySelector('script,iframe,svg,object,embed,form'),eventAttrs:all.some(e=>[...e.attributes].some(a=>/^on/i.test(a.name))),badHref:!!doc.querySelector('a[href^="javascript:" i],a[href^="data:" i]'),badImage:!!doc.querySelector('img[src^="data:image/svg+xml" i],img:not([src])'),badCss:all.some(e=>/url\\(|expression\\(|javascript:/i.test(e.getAttribute('style')||'')),safeLink:doc.querySelector('a[href="https://example.com/path"]')?.getAttribute('rel')==='noopener noreferrer',formatting:!!doc.querySelector('p[style*="color"]')&&!!doc.querySelector('table td[bgcolor]'),plainText:doc.body.textContent.includes('Safe formatting')&&doc.body.textContent.includes('table'),templateChecks,xss:globalThis.__sfmXss||null}})()`;
    const result = await command(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const value = result.result?.value;
    if (!value) throw new Error(`Chromium sanitizer evaluation returned no value: ${JSON.stringify(result)}`);
    const failed = ['script','eventAttrs','badHref','badImage','badCss'].filter(k => value[k]);
    const badTemplates = (value.templateChecks || []).filter(t => !t.ok);
    if (value.xss || failed.length || badTemplates.length || !value.safeLink || !value.formatting || !value.plainText) {
      throw new Error(`Composer sanitizer smoke failed: ${JSON.stringify({ ...value, failed }, null, 2)}`);
    }
    console.log(JSON.stringify({ result: 'PASS', mode: 'actual Chromium DOMParser', checks: { blockedActiveMarkup: true, strippedEventHandlers: true, rejectedUnsafeUrls: true, rejectedSvgDataImage: true, removedUnsafeCss: true, safeLinksKept: true, emailFormattingKept: true, textKept: true }, builtInTemplateCount: value.templateChecks.length, builtInTemplates: value.templateChecks, output: value.html }, null, 2));
  } finally {
    for (const pending of command.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Browser test finished')); }
    command.pending.clear();
    try { ws?.close(); } catch {}
    if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 300)); }
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
