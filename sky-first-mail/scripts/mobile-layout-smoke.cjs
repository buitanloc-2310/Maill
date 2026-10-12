'use strict';

// Network-free mobile UI smoke test. It runs the real public CSS and frontend
// scripts inside Chromium's about:blank context, with an isolated mock API.
// It does not access production, localhost, or send any email.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(p => fs.existsSync(p));
const OUT = path.resolve(process.env.TEST_ARTIFACT_DIR || path.join(os.tmpdir(), 'sky-first-mail-mobile-smoke'));

const pending = new Map();
let commandId = 0;
async function cdp(ws, method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function main() {
  if (!CHROME) throw new Error('Chromium/Chrome not found; set CHROMIUM_PATH to a browser executable');
  await fsp.mkdir(OUT, { recursive: true });
  const [css, app, v3, v4, v5] = await Promise.all(['public/styles.css','public/app.js','public/v3.js','public/v4.js','public/v5.js'].map(f => fsp.readFile(path.join(ROOT, f), 'utf8')));
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfm-mobile-chrome-'));
  let chrome, ws;
  const browserErrors = [];
  try {
    chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
    let stderr=''; chrome.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 4000) stderr=stderr.slice(-4000); });
    const active = path.join(profile,'DevToolsActivePort'); let port=0; const deadline=Date.now()+12000;
    while(Date.now()<deadline && chrome.exitCode===null){try{port=Number((await fsp.readFile(active,'utf8')).split(/\r?\n/)[0]);if(port)break}catch{} await new Promise(r=>setTimeout(r,100));}
    if(!port) throw new Error(`Chromium remote debugging failed to start. ${stderr}`);
    const targetRes=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
    if(!targetRes.ok) throw new Error(`Could not create about:blank target: HTTP ${targetRes.status}`);
    const target=await targetRes.json(); ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Timed out connecting to Chromium DevTools')),5000);ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('DevTools WebSocket failed'))},{once:true})});
    ws.addEventListener('message',event=>{let packet;try{packet=JSON.parse(String(event.data))}catch{return}if(!packet.id)return;const p=pending.get(packet.id);if(!p)return;pending.delete(packet.id);if(packet.error)p.reject(new Error(packet.error.message||'CDP command failed'));else p.resolve(packet.result||{})});
    await cdp(ws,'Runtime.enable'); await cdp(ws,'Page.enable');
    const fakeApi = `window.__sfmApiCalls=[];window.__sfmErrors=[];window.__sfmDraftSaveCount=0;window.__sfmMockSendCount=0;window.__sfmMockSendRecipient='';if(!crypto.randomUUID)Object.defineProperty(Crypto.prototype,'randomUUID',{value:()=>'mobile-smoke-test-'+String(Date.now())+'-'+Math.random().toString(36).slice(2),configurable:true});window.addEventListener('error',e=>window.__sfmErrors.push(String(e.message||'error')));window.confirm=()=>true;window.prompt=()=>null;window.fetch=async(input,opts={})=>{const raw=typeof input==='string'?input:(input&&input.url)||String(input);const u=new URL(raw,'https://isolated.skyfirst.test');const method=String(opts.method||'GET').toUpperCase();window.__sfmApiCalls.push({path:u.pathname,query:u.search,method,origin:u.origin});const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8'}});const user={id:1,displayName:'Nguyễn An',email:'an@skyfirst.io.vn',role:'super_admin',avatarKey:null,profileStatus:'available',allowNameChange:true,allowAvatarChange:true,allowPasswordChange:true,allowSignatureChange:true,allowThemeChange:true,preferences:{theme:'sky'}};const msg={id:1,sender:'sender@example.test',recipients_json:'["an@skyfirst.io.vn"]',subject:'Thư thử nghiệm trên điện thoại',preview:'Nội dung tiếng Việt để kiểm tra chiều rộng và khả năng đọc.',is_read:0,is_starred:0,is_important:0,received_at:'2026-10-12T00:00:00.000Z',sent_at:null,created_at:'2026-10-12T00:00:00.000Z'};if(u.pathname==='/library/compose-library.json')return json({templates:[]});if(u.pathname==='/api/bootstrap/status')return json({setupCompleted:true});if(u.pathname==='/api/me')return json({user});if(u.pathname==='/api/mailboxes')return json({mailboxes:[{id:1,address:'an@skyfirst.io.vn',display_name:user.displayName,is_primary:1,is_active:1}]});if(u.pathname==='/api/messages'&&method==='GET')return json({messages:[msg],nextCursor:null,hasMore:false});if(u.pathname==='/api/messages/1'&&method==='GET')return json({message:{...msg,parsed:{subject:msg.subject,text:'Nội dung thử nghiệm',html:'<h2>Xin chào</h2><p>Đây là nội dung email mẫu dùng kiểm tra giao diện responsive.</p><table><tr><td>Bảng thử nghiệm</td><td>Giá trị</td></tr></table>',attachments:[{index:0,filename:'Tai-lieu-tham-khao.pdf',mimeType:'application/pdf',size:1024}]}}});if(u.pathname==='/api/mailbox/summary')return json({counts:{inbox:1,starred:0,sent:0,drafts:0,spam:0,trash:0},unread:1});if(u.pathname==='/api/sender-identities')return json({mailboxes:[{id:1,address:user.email,is_primary:1}],aliases:[]});if(u.pathname==='/api/templates')return json({templates:[]});if(u.pathname==='/api/signatures')return json({signatures:[]});if(u.pathname==='/api/rules')return json({rules:[]});if(u.pathname==='/api/drafts'&&method==='GET')return json({drafts:[]});if(u.pathname==='/api/drafts'&&method==='POST'){window.__sfmDraftSaveCount++;return json({id:7,ok:true});}if(u.pathname==='/api/compose'&&method==='POST'){window.__sfmMockSendCount++;window.__sfmMockSendRecipient=opts.body instanceof FormData?String(opts.body.get('to')||''):'';return json({ok:true,operationId:'mobile-smoke-only',status:'completed'});}if(u.pathname==='/api/sessions')return json({sessions:[],currentSessionId:1});if(u.pathname==='/api/contacts')return json({contacts:[]});if(u.pathname==='/api/directory')return json({people:[]});if(u.pathname.startsWith('/api/notifications'))return json({notifications:[]});if(u.pathname.startsWith('/api/'))return json({ok:true,users:[],aliases:[],domains:[],logs:[],stats:{users:1,activeMailboxes:1,messages:1,bytes:0,unread:1},storage:{messageBytes:0},accounts:{users:1},services:{sending:false},operations:[]});return new Response('',{status:404});};`;
    const sourceExpression = `(()=>{document.title='Sky First Mail — isolated mobile smoke';document.documentElement.lang='vi';document.head.innerHTML='<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Sky First Mail</title>';document.body.innerHTML='<div id="app"></div>';const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);${fakeApi}const add=(code,wrap=false)=>{const el=document.createElement('script');el.textContent=wrap?'(()=>{\\n'+code+'\\n})()':code;document.body.appendChild(el)};add(${JSON.stringify(app)},true);add(${JSON.stringify(v3)});add(${JSON.stringify(v4)});add(${JSON.stringify(v5)});return 'injected'} )()`;
    const evalValue=async expression=>{const r=await cdp(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||r.exceptionDetails.exception?.description||'Browser evaluation failed');return r.result?.value};
    await evalValue(sourceExpression);
    const waitFor=async(expr,label)=>{const until=Date.now()+12000;while(Date.now()<until){try{if(await evalValue(expr))return}catch{}await new Promise(r=>setTimeout(r,100))}const diag=await evalValue("({url:location.href,body:(document.body.innerText||'').slice(0,700),errors:window.__sfmErrors,apiCalls:window.__sfmApiCalls,sendCount:window.__sfmMockSendCount,composeMessage:document.querySelector('#v5-msg')?.textContent,saveState:document.querySelector('#v5-save-state')?.textContent})");throw new Error(`Timeout waiting for ${label}: ${JSON.stringify(diag)}`)};
    await waitFor("document.querySelector('#rows .row') && document.querySelector('#mobileMore')",'real inbox and mobile navigation');
    // Inline the real local brand asset for the about:blank evidence screenshot; no origin fetch is made.
    const logoData=fs.readFileSync(path.join(ROOT,'public/sky-first-logo.png')).toString('base64');
    await evalValue(`document.querySelectorAll('img.brand-logo').forEach(img=>img.src='data:image/png;base64,${logoData}');true`);
    const viewports=[];
    for(const [width,height] of [[320,740],[360,800],[390,844],[430,932],[768,1024],[844,390],[932,430],[1440,1000]]){
      await cdp(ws,'Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=430,screenWidth:width,screenHeight:height});
      await new Promise(r=>setTimeout(r,120));
      const info=await evalValue(`({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1||document.body.scrollWidth>innerWidth+1,sidebar:!!document.querySelector('.workspace>aside'),primary:[...document.querySelectorAll('.workspace>aside nav [data-folder]')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.dataset.folder),moreVisible:getComputedStyle(document.querySelector('#mobileMore')).display!=='none',composeVisible:!!document.querySelector('#compose')&&getComputedStyle(document.querySelector('#compose')).display!=='none',labels:[...document.querySelectorAll('.workspace>aside nav .navbtn[data-folder]')].filter(e=>['inbox','starred','sent','drafts'].includes(e.dataset.folder)).map(e=>({folder:e.dataset.folder,label:getComputedStyle(e,'::after').content,visible:getComputedStyle(e,'::after').display!=='none'}))})`);
      viewports.push(info);
      if(info.overflow)throw new Error(`Horizontal overflow at ${width}px: ${JSON.stringify(info)}`);
      if(width<=430 && (!info.moreVisible||!info.composeVisible||!['inbox','starred','sent','drafts'].every(k=>info.primary.includes(k))))throw new Error(`Mobile primary navigation missing at ${width}px: ${JSON.stringify(info)}`);
      if(width===390)await cdp(ws,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(OUT,'mail-inbox-390.png'),Buffer.from(r.data,'base64')));
    }
    // Return to a phone viewport for interaction checks after the responsive width sweep.
    await cdp(ws,'Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenWidth:390,screenHeight:844});
    await new Promise(r=>setTimeout(r,120));
    // Open the More menu and verify that secondary folders and user tools are reachable.
    await evalValue("document.querySelector('#mobileMore').click();true");
    await waitFor("document.querySelector('.mobile-menu [data-mobile-folder=\\\"trash\\\"]') && document.querySelector('.mobile-menu [data-mobile-action=\\\"contacts\\\"]')",'mobile More menu entries');
    const menu=await evalValue("({items:[...document.querySelectorAll('.mobile-menu-item')].map(b=>b.innerText.replace(/\\\\s+/g,' ').trim()),overflow:document.documentElement.scrollWidth>innerWidth+1})");
    if(menu.overflow)throw new Error(`More menu overflows viewport: ${JSON.stringify(menu)}`);
    await cdp(ws,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(OUT,'mail-more-menu-390.png'),Buffer.from(r.data,'base64')));
    await evalValue("document.querySelector('.mobile-menu [data-mobile-folder=\\\"snoozed\\\"]').click();true");
    await waitFor("document.querySelector('#folderTitle')?.textContent==='Đã hoãn'",'folder switch through More menu');
    const menuNav=await evalValue("({title:document.querySelector('#folderTitle').textContent,moreActive:document.querySelector('#mobileMore').classList.contains('active'),apiCalled:window.__sfmApiCalls.some(x=>x.path==='/api/messages'&&x.query.includes('folder=snoozed'))})");
    if(menuNav.title!=='Đã hoãn'||!menuNav.moreActive||!menuNav.apiCalled)throw new Error(`Secondary folder menu navigation failed: ${JSON.stringify(menuNav)}`);
    // Read an email and check the fixed reader area does not cross into the bottom nav.
    await evalValue("document.querySelector('.workspace').classList.remove('reading');document.querySelector('[data-folder=\\\"inbox\\\"]').click();true");
    await waitFor("document.querySelector('#rows .row')",'return to inbox');
    await evalValue("document.querySelector('#rows .row').click();true");
    await waitFor("document.querySelector('.workspace.reading #reader .message')",'email reader');
    const reader=await evalValue("(()=>{const r=document.querySelector('.workspace.reading>main').getBoundingClientRect(),n=document.querySelector('.workspace>aside').getBoundingClientRect();return{readerTop:r.top,readerBottom:r.bottom,navTop:n.top,notOverlapped:r.bottom<=n.top+2,subject:document.querySelector('#reader h1')?.textContent||''}})()");
    if(!reader.notOverlapped)throw new Error(`Reader overlaps mobile nav: ${JSON.stringify(reader)}`);
    await cdp(ws,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(OUT,'mail-reader-390.png'),Buffer.from(r.data,'base64')));
    // Open the real advanced composer implementation and verify it fits small screens.
    await evalValue("document.querySelector('#compose').click();true");
    await waitFor("document.querySelector('.v5-wrap .v5-compose #v5-form')",'Mail Studio composer');
    const compose=await evalValue("(()=>{const w=document.querySelector('.v5-wrap>.v5-compose').getBoundingClientRect();return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,composeLeft:w.left,composeRight:w.right,composeWidth:w.width,recipientFields:['#v5-to','#v5-cc','#v5-bcc'].map(s=>!!document.querySelector(s)),editor:!!document.querySelector('#v5-visual'),attachment:!!document.querySelector('#v5-files'),send:!!document.querySelector('#v5-send')}})()");
    if(compose.documentWidth>compose.width+1||compose.composeLeft < -1||compose.composeRight>compose.width+1||!compose.recipientFields.every(Boolean)||!compose.editor||!compose.attachment||!compose.send)throw new Error(`Mobile composer smoke failed: ${JSON.stringify(compose)}`);
    const composerViewports=[];
    for(const [width,height] of [[320,740],[360,800],[390,844],[430,932],[844,390]]){
      await cdp(ws,'Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height});
      await new Promise(r=>setTimeout(r,100));
      const info=await evalValue(`(()=>{const w=document.querySelector('.v5-wrap>.v5-compose').getBoundingClientRect();const editor=document.querySelector('#v5-visual').getBoundingClientRect();return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1||document.body.scrollWidth>innerWidth+1,composeLeft:w.left,composeRight:w.right,composeWidth:w.width,editorLeft:editor.left,editorRight:editor.right,sendAvailable:!!document.querySelector('#v5-send'),recipientFields:['#v5-to','#v5-cc','#v5-bcc'].every(s=>!!document.querySelector(s))}})()`);
      composerViewports.push(info);
      if(info.overflow||info.composeLeft < -1||info.composeRight>width+1||!info.sendAvailable||!info.recipientFields)throw new Error(`Composer overflow/control failure at ${width}px: ${JSON.stringify(info)}`);
      if(width===390)await cdp(ws,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(OUT,'mail-compose-390.png'),Buffer.from(r.data,'base64')));
    }
    await cdp(ws,'Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenWidth:390,screenHeight:844});
    await evalValue("(()=>{const to=document.querySelector('#v5-to'),subject=document.querySelector('#v5-subject'),visual=document.querySelector('#v5-visual');to.value='mobile-test@example.test';subject.value='Bản nháp kiểm thử mobile';visual.innerHTML='<p>Nội dung thử nghiệm</p>';to.dispatchEvent(new Event('input',{bubbles:true}));subject.dispatchEvent(new Event('input',{bubbles:true}));visual.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#v5-save-draft').click();return true})()");
    await waitFor("window.__sfmDraftSaveCount===1 && document.querySelector('#v5-save-state')?.textContent.includes('Đã lưu nháp')",'mobile save-draft action');
    await evalValue("document.querySelector('#v5-send-test').click();true");
    await waitFor("window.__sfmMockSendCount===1",'mocked Send Test action');
    const composerActions=await evalValue("({draftSaves:window.__sfmDraftSaveCount,mockSends:window.__sfmMockSendCount,mockRecipient:window.__sfmMockSendRecipient,realNetwork:window.__sfmApiCalls.some(x=>x.origin!=='https://isolated.skyfirst.test')})");
    if(composerActions.draftSaves!==1||composerActions.mockSends!==1||composerActions.mockRecipient!=='an@skyfirst.io.vn'||composerActions.realNetwork)throw new Error(`Mobile composer action test failed: ${JSON.stringify(composerActions)}`);const inlineStatus=await evalValue("({text:document.querySelector('#v5-msg')?.textContent||'',role:document.querySelector('#v5-msg')?.getAttribute('role')||'',globalToast:!!document.querySelector('#v5-toasts')})");if(!inlineStatus.text.includes('Đã gửi thư thử cho chính bạn')||inlineStatus.role!=='status'||inlineStatus.globalToast)throw new Error(`Composer status must be accessible and non-overlapping: ${JSON.stringify(inlineStatus)}`);
    await evalValue("(()=>{const p=document.querySelector('.v5-wrap>.v5-compose');p.scrollTop=p.scrollHeight;return true})()");
    await waitFor("(()=>{const r=document.querySelector('#v5-send').getBoundingClientRect();return r.top>=-1 && r.bottom<=innerHeight+1})()",'send button after scrolling to composer actions');
    await cdp(ws,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(OUT,'mail-compose-footer-390.png'),Buffer.from(r.data,'base64')));
    const final=await evalValue("({errors:window.__sfmErrors||[],apiCalls:window.__sfmApiCalls?.length||0,scrollWidth:document.documentElement.scrollWidth,innerWidth,compose:!!document.querySelector('#v5-form')})");
    if(final.errors.length)throw new Error(`Frontend JavaScript errors: ${JSON.stringify(final.errors)}`);
    const report={result:'PASS',mode:'real Chromium DOM + actual CSS/app/v3/v4/v5 with isolated mock API in about:blank; local logo embedded as data URI for screenshot',network:'none',production:'not accessed',emailSent:false,viewports,moreMenu:menu,secondaryFolderNavigation:menuNav,reader,composer:compose,composerViewports,composerActions,inlineStatus,final,browserErrors:final.errors,screenshots:['mail-inbox-390.png','mail-more-menu-390.png','mail-reader-390.png','mail-compose-390.png','mail-compose-footer-390.png']};
    await fsp.writeFile(path.join(OUT,'mobile-smoke-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ ...report,artifactDirectory:OUT },null,2));
  } finally {
    for(const p of pending.values())p.reject(new Error('Smoke test ended'));pending.clear();
    try{ws?.close()}catch{}
    if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(r=>setTimeout(r,300))}
    await fsp.rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
