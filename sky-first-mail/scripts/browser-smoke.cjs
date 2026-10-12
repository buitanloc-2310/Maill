'use strict';

// Dependency-free Chromium smoke test. It exercises the real frontend against a
// deliberately isolated mock API; it never connects to production or sends mail.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..', 'public');
const CHROME = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(p => fs.existsSync(p));
const OUT = path.resolve(process.env.TEST_ARTIFACT_DIR || path.join(os.tmpdir(), 'sky-first-mail-browser-smoke'));
const SETUP_SECRET = 'local-mail-setup-secret-local-test-2026';
const events = [];
let setupCompleted = false;
let sendCount = 0;
let draftCount = 0;

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function messageList() {
  return { messages: [{
    id: 1, sender: 'sender@example.test', recipients_json: '["admin@skyfirst.io.vn"]',
    subject: 'Kiểm thử giao diện · tiếng Việt', preview: 'Nội dung thư kiểm thử',
    is_read: 0, is_starred: 0, is_important: 0,
    received_at: '2026-10-12T00:00:00.000Z', sent_at: null, created_at: '2026-10-12T00:00:00.000Z'
  }], nextCursor: null, hasMore: false };
}
function messageDetail() {
  return { message: {
    id: 1, sender: 'sender@example.test', recipients_json: '["admin@skyfirst.io.vn"]',
    subject: 'Kiểm thử giao diện · tiếng Việt', is_read: 0, is_starred: 0, is_important: 0,
    received_at: '2026-10-12T00:00:00.000Z', parsed: {
      subject: 'Kiểm thử giao diện · tiếng Việt', text: 'Nội dung thư kiểm thử',
      html: '<h2>Thư kiểm thử</h2><p>Tiếng Việt: Xin chào.</p><img src="https://image.invalid/tracker.png" onerror="window.__sfmXss=1"><script>window.__sfmXss=2</script><a href="javascript:window.__sfmXss=3">Liên kết không an toàn</a><a href="https://example.com/help" onclick="window.__sfmXss=4">Liên kết ngoài an toàn</a>',
      attachments: []
    }
  } };
}
async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
      if (url.pathname.startsWith('/api/')) {
        let body = Buffer.alloc(0);
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          body = Buffer.concat(chunks);
        }
        events.push({ method: req.method, path: url.pathname, query: url.search, bytes: body.length });
        if (url.pathname === '/api/bootstrap/status') return json(res, 200, { setupCompleted });
        if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
          if (req.headers['x-setup-secret'] !== SETUP_SECRET) return json(res, 403, { error: 'Invalid local test setup secret' });
          setupCompleted = true;
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/me') return setupCompleted ? json(res, 200, { user: { id: 1, displayName: 'Browser Admin', email: 'admin@skyfirst.io.vn', role: 'super_admin', avatarKey: null, preferences: { theme: 'system' } } }) : json(res, 401, { error: 'Unauthorized' });
        if (url.pathname === '/api/mailboxes') return json(res, 200, { mailboxes: [{ id: 1, address: 'admin@skyfirst.io.vn', display_name: 'Browser Admin', is_primary: 1, is_active: 1 }] });
        if (url.pathname === '/api/messages' && req.method === 'GET') return json(res, 200, messageList());
        if (url.pathname === '/api/messages/1' && req.method === 'GET') return json(res, 200, messageDetail());
        if (url.pathname === '/api/sender-identities') return json(res, 200, { mailboxes: [{ id: 1, address: 'admin@skyfirst.io.vn', is_primary: 1 }], aliases: [] });
        if (url.pathname === '/api/templates') return json(res, 200, { templates: [] });
        if (url.pathname === '/api/signatures') return json(res, 200, { signatures: [] });
        if (url.pathname === '/api/directory') return json(res, 200, { people: [] });
        if (url.pathname === '/api/contacts') return json(res, 200, { contacts: [] });
        if (url.pathname === '/api/drafts' && req.method === 'POST') return json(res, 200, { id: ++draftCount, ok: true });
        if (url.pathname === '/api/compose' && req.method === 'POST') { sendCount++; return json(res, 200, { ok: true, operationId: `browser-smoke-${sendCount}`, status: 'completed' }); }
        if (url.pathname.startsWith('/api/notifications')) return json(res, 200, { notifications: [] });
        if (url.pathname.startsWith('/api/messages/1/proofline')) return json(res, 200, { message: { id: 1 }, integrity: { matches: true } });
        if (url.pathname.startsWith('/api/')) return json(res, 200, { ok: true, users: [], aliases: [], domains: [], logs: [], stats: { users: 1, activeMailboxes: 1, messages: 1, bytes: 0, unread: 1 }, storage: { messageBytes: 0 }, accounts: { users: 1 }, services: { sending: false } });
      }
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(ROOT, '.' + requested);
      if (!(file === ROOT || file.startsWith(ROOT + path.sep))) return json(res, 403, { error: 'Forbidden' });
      const bytes = await fsp.readFile(file);
      const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(bytes);
    } catch (error) {
      json(res, 500, { error: 'Local browser smoke server error', detail: String(error?.message || error) });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

class CDP {
  constructor(ws) { this.ws = ws; this.nextId = 0; this.pending = new Map(); this.listeners = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const c = new CDP(ws);
    ws.addEventListener('message', event => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id); c.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP command failed'));
        else p.resolve(msg.result || {});
      } else if (msg.method) for (const fn of c.listeners.get(msg.method) || []) fn(msg.params || {});
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { const list = this.listeners.get(method) || []; list.push(fn); this.listeners.set(method, list); }
  evaluate(expression, contextId = null) {
    const params = { expression, awaitPromise: true, returnByValue: true, userGesture: true };
    if (contextId !== null) params.contextId = contextId;
    return this.send('Runtime.evaluate', params).then(r => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'Browser evaluate failed');
      return r.result?.value;
    });
  }
  async waitFor(expression, label, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await this.evaluate(expression)) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    let state='unavailable'; try { state=JSON.stringify(await this.evaluate('({url:location.href,title:document.title,body:(document.body?.innerText||"").slice(0,800)})')); } catch (e) { state=String(e?.message||e); } throw new Error(`Timed out waiting for ${label}; page=${state}`);
  }
  close() { try { this.ws.close(); } catch {} }
}
async function main() {
  if (!CHROME || !fs.existsSync(CHROME)) throw new Error('Chromium/Chrome not found; set CHROMIUM_PATH to a browser executable');
  await fsp.mkdir(OUT, { recursive: true });
  const { server, port } = await startServer();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfm-chrome-'));
  let chrome;
  let cdp;
  const errors = [];
  let mainFrameId = null;
  const executionContexts = new Map();
  try {
    chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    const activeFile = path.join(profile, 'DevToolsActivePort');
    let debugPort;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && chrome.exitCode === null) {
      try { debugPort = Number((await fsp.readFile(activeFile, 'utf8')).split(/\r?\n/)[0]); if (debugPort) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!debugPort) throw new Error(`Chromium remote debugging failed to start. ${stderr}`);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    if (!targetResponse.ok) throw new Error(`Chromium target creation failed: HTTP ${targetResponse.status}`);
    const target = await targetResponse.json();
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    cdp.on('Page.frameNavigated', p => { if (!p.frame.parentId) mainFrameId = p.frame.id; });
    cdp.on('Runtime.executionContextCreated', p => {
      const context = p.context;
      const frameId = context?.auxData?.frameId;
      if (context?.auxData?.type === 'default' && frameId) executionContexts.set(frameId, context.id);
    });
    cdp.on('Runtime.executionContextDestroyed', p => {
      for (const [frameId, contextId] of executionContexts) if (contextId === p.executionContextId) executionContexts.delete(frameId);
    });
    cdp.on('Runtime.executionContextsCleared', () => executionContexts.clear());
    cdp.on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Unhandled browser exception'));
    cdp.on('Log.entryAdded', p => { if (p.entry?.level === 'error' && !/favicon|net::ERR_ABORTED/i.test(p.entry.text || '')) errors.push(p.entry.text); });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await cdp.waitFor("document.querySelector('[name=setupSecret]') !== null", 'initial setup form');
    await cdp.evaluate(`(()=>{const values={setupSecret:${JSON.stringify(SETUP_SECRET)},displayName:'Browser Admin',email:'admin@skyfirst.io.vn',password:'local-test-password',confirm:'local-test-password'};for(const [name,value] of Object.entries(values)){const el=document.querySelector('[name="'+name+'"]');if(!el)throw Error('Missing setup field '+name);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#f').requestSubmit();return true})()`);
    await cdp.waitFor("document.querySelector('#compose') !== null", 'main mailbox after mocked setup');
    await cdp.waitFor("document.querySelector('.rowbody') !== null", 'inbox message row');
    await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(r => fs.writeFileSync(path.join(OUT, 'mail-desktop.png'), Buffer.from(r.data, 'base64')));
    await cdp.evaluate("document.querySelector('.rowbody')?.click(); true");
    await cdp.waitFor("document.querySelector('#mailframe') !== null", 'email reader iframe');
    await cdp.waitFor("!!document.querySelector('#mailframe').srcdoc && document.querySelector('#mailframe').srcdoc.includes('Thư kiểm thử')", 'email iframe srcdoc');
    // Inspect the actual iframe document through CDP so this test does not
    // alter or weaken the sandbox permissions configured by the application.
    let iframeContextId = null;
    const frameDeadline = Date.now() + 7000;
    while (Date.now() < frameDeadline && iframeContextId === null) {
      const tree = await cdp.send('Page.getFrameTree');
      const findSrcdoc = node => {
        if (!node) return null;
        if (node.frame?.parentId === mainFrameId && /^(?:about:srcdoc|about:blank)$/.test(node.frame.url || '')) return node.frame;
        for (const child of node.childFrames || []) { const found = findSrcdoc(child); if (found) return found; }
        return null;
      };
      const subframe = findSrcdoc(tree.frameTree);
      if (subframe) iframeContextId = executionContexts.get(subframe.id) ?? null;
      if (iframeContextId === null) await new Promise(r => setTimeout(r, 100));
    }
    if (iframeContextId === null) throw new Error('Could not attach to the sandboxed email iframe execution context; the sandbox remains unchanged.');
    let reader = null;
    const readerDeadline = Date.now() + 5000;
    while (Date.now() < readerDeadline) {
      try {
        reader = await cdp.evaluate(`(()=>{const doc=document;const meta=doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');return {hasCsp:!!meta&&/script-src 'none'/.test(meta.content),remoteImagePolicy:!!meta&&/img-src[^;]*https:[^;]*http:|img-src[^;]*http:[^;]*https:/i.test(meta.content),hasScript:!!doc.querySelector('script'),hasEventHandler:[...doc.querySelectorAll('*')].some(el=>[...el.attributes].some(a=>/^on/i.test(a.name))),unsafeHref:!!doc.querySelector('a[href^="javascript:" i]'),remoteImageHasSrc:!!doc.querySelector('img[src^="https://image.invalid"]'),safeExternalLink:(()=>{const a=doc.querySelector('a[href="https://example.com/help"]');return !!a&&a.target==='_blank'&&/noopener/.test(a.rel)&&!a.hasAttribute('onclick')})(),readerTitle:doc.body?.textContent?.trim().slice(0,100)||''}})()`, iframeContextId);
        if (reader?.readerTitle.includes('Thư kiểm thử')) break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!reader?.readerTitle.includes('Thư kiểm thử')) throw new Error(`Sanitized email body did not render in the sandboxed iframe: ${JSON.stringify(reader)}`);
    if (!reader.hasCsp || !reader.remoteImagePolicy || reader.hasScript || reader.hasEventHandler || reader.unsafeHref || !reader.remoteImageHasSrc || !reader.safeExternalLink) throw new Error(`Email reader image/link policy smoke failed: ${JSON.stringify(reader)}`);
    await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(r => fs.writeFileSync(path.join(OUT, 'mail-reader.png'), Buffer.from(r.data, 'base64')));
    await cdp.evaluate("document.querySelector('#compose').click(); true");
    await cdp.waitFor("document.querySelector('#v5-to') !== null", 'Mail Studio composer');
    await cdp.evaluate(`(()=>{document.querySelector('#v5-to').value='qa-inbox@example.test';document.querySelector('#v5-to').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#v5-subject').value='Browser smoke test';document.querySelector('#v5-subject').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#v5-visual').innerHTML='<p>Body from Chromium smoke test.</p>';document.querySelector('#v5-visual').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#v5-save-draft').click();return true})()`);
    await cdp.waitFor("document.querySelector('#v5-save-state')?.textContent.includes('Đã lưu nháp')", 'draft-save confirmation');
    await cdp.evaluate("document.querySelector('#v5-send').click(); true");
    await cdp.waitFor("!document.querySelector('.v5-wrap')", 'composer close after mocked send');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
    await cdp.evaluate('window.dispatchEvent(new Event("resize")); true');
    await new Promise(r => setTimeout(r, 250));
    await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(r => fs.writeFileSync(path.join(OUT, 'mail-mobile.png'), Buffer.from(r.data, 'base64')));
    const mobile = await cdp.evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,composeVisible:!!document.querySelector("#compose"),setupCompleted:document.querySelector("#compose")!==null})');
    const overflow = mobile.overflow;
    if (overflow) throw new Error(`Horizontal overflow at 390px: ${JSON.stringify(mobile)}`);
    if (draftCount < 1 || sendCount < 1) throw new Error(`Mock API did not observe draft/send actions: draft=${draftCount}, send=${sendCount}`);
    if (errors.length || overflow) process.exitCode = 1;
    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    const report = { result: 'PASS', mode: 'real Chromium browser + isolated mock API (not production)', viewportDesktop: '1440x1000', viewportMobile: '390x844', setup: 'PASS', inboxRender: 'PASS', sanitizedReader: reader, draftSave: 'PASS', mockedSend: 'PASS', mobile, browserErrors: errors, apiRequests: events, screenshots: ['mail-desktop.png', 'mail-reader.png', 'mail-mobile.png'] };
    fs.writeFileSync(path.join(OUT, 'browser-smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([once(chrome, 'exit'), new Promise(r => setTimeout(r, 2000))]); }
    server.close();
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
