'use strict';
// Isolated Chromium smoke test for real admin UI handlers with a mock API.
// This tests DOM/event wiring only; it never contacts production or performs real account changes.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].find(p => fs.existsSync(p));
const pending = new Map(); let commandId = 0;
async function cdp(ws, method, params={}) {
  const id=++commandId;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},12000);
    pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v)},reject:e=>{clearTimeout(timeout);reject(e)}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function main(){
 if(!CHROME)throw new Error('Chromium not found; set CHROMIUM_PATH.');
 const [css,dialogs,app,v3,v4,v5]=await Promise.all(['public/styles.css','public/ui-dialogs.js','public/app.js','public/v3.js','public/v4.js','public/v5.js'].map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')));
 const profile=await fsp.mkdtemp(path.join(os.tmpdir(),'sfm-admin-chrome-'));
 let chrome,ws;
 try{
  chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr='';chrome.stderr.on('data',d=>{stderr+=d.toString();if(stderr.length>4000)stderr=stderr.slice(-4000)});
  const portFile=path.join(profile,'DevToolsActivePort');let port=0;const deadline=Date.now()+12000;
  while(Date.now()<deadline&&chrome.exitCode===null){try{port=Number((await fsp.readFile(portFile,'utf8')).split(/\r?\n/)[0]);if(port)break}catch{}await new Promise(r=>setTimeout(r,100))}
  if(!port)throw new Error(`Chromium failed to start: ${stderr}`);
  const targetRes=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});if(!targetRes.ok)throw new Error(`Could not open blank target: ${targetRes.status}`);
  const target=await targetRes.json();ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('DevTools connection timeout')),5000);ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('DevTools connection failed'))},{once:true})});
  ws.addEventListener('message',event=>{let p;try{p=JSON.parse(String(event.data))}catch{return}if(!p.id)return;const x=pending.get(p.id);if(!x)return;pending.delete(p.id);if(p.error)x.reject(new Error(p.error.message||'CDP error'));else x.resolve(p.result||{})});
  await cdp(ws,'Runtime.enable');await cdp(ws,'Page.enable');
  const fakeApi=String.raw`
   window.__sfmErrors=[];window.__nativeDialogs=[];window.__sfmApiCalls=[];
   window.addEventListener('error',e=>window.__sfmErrors.push(String(e.message||'error')));
   window.addEventListener('unhandledrejection',e=>window.__sfmErrors.push(String(e.reason?.message||e.reason||'unhandled rejection')));
   window.alert=(...x)=>{window.__nativeDialogs.push('alert');};window.confirm=(...x)=>{window.__nativeDialogs.push('confirm');return true};window.prompt=(...x)=>{window.__nativeDialogs.push('prompt');return null};
   window.__adminUsers=[
    {id:1,email:'root@skyfirst.io.vn',display_name:'Super Admin',role:'super_admin',status:'active',avatar_key:null,allow_name_change:1,allow_avatar_change:1,allow_password_change:1,allow_signature_change:1,allow_theme_change:1,last_login_at:null,mailbox_count:1,primary_mailbox_id:1},
    {id:2,email:'editme@skyfirst.io.vn',display_name:'Tài khoản thử',role:'user',status:'active',avatar_key:null,allow_name_change:1,allow_avatar_change:1,allow_password_change:1,allow_signature_change:1,allow_theme_change:1,last_login_at:null,mailbox_count:1,primary_mailbox_id:2}
   ];window.__nextAdminUserId=3;
   const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8'}});
   window.fetch=async(input,opts={})=>{
    const raw=typeof input==='string'?input:(input&&input.url)||String(input),u=new URL(raw,'https://isolated.skyfirst.test'),p=u.pathname,m=String(opts.method||'GET').toUpperCase();
    window.__sfmApiCalls.push({path:p,method:m});let b={};try{b=opts.body?JSON.parse(opts.body):{}}catch{}
    const me={id:1,displayName:'Super Admin',email:'root@skyfirst.io.vn',role:'super_admin',avatarKey:null,profileStatus:'available',allowNameChange:true,allowAvatarChange:true,allowPasswordChange:true,allowSignatureChange:true,allowThemeChange:true,preferences:{theme:'sky'}};
    if(p==='/api/bootstrap/status')return json({setupCompleted:true});
    if(p==='/api/me')return json({user:me});
    if(p==='/api/mailboxes')return json({mailboxes:[{id:1,address:me.email,display_name:me.displayName,is_primary:1,is_active:1}]});
    if(p==='/api/messages')return json({messages:[],nextCursor:null,hasMore:false});
    if(p==='/api/mailbox/summary')return json({counts:{inbox:0,starred:0,sent:0,drafts:0,spam:0,trash:0},unread:0});
    if(p==='/api/sender-identities')return json({mailboxes:[{id:1,address:me.email,is_primary:1}],aliases:[]});
    if(p==='/api/admin/dashboard')return json({ok:true,stats:{users:window.__adminUsers.length,activeMailboxes:window.__adminUsers.length,messages:0,bytes:0,unread:0}});
    if(p==='/api/admin/users'&&m==='GET')return json({ok:true,users:window.__adminUsers.map(x=>({...x}))});
    if(p==='/api/admin/users'&&m==='POST'){
      if(window.__adminUsers.some(x=>x.email.toLowerCase()===String(b.email||'').toLowerCase()))return json({ok:false,error:'Email đã tồn tại.'},400);
      const user={id:window.__nextAdminUserId++,email:b.email,display_name:b.displayName,role:b.role||'user',status:b.status||'active',avatar_key:null,allow_name_change:+!!b.allowNameChange,allow_avatar_change:+!!b.allowAvatarChange,allow_password_change:+(b.allowPasswordChange!==false),allow_signature_change:+(b.allowSignatureChange!==false),allow_theme_change:+(b.allowThemeChange!==false),last_login_at:null,mailbox_count:1,primary_mailbox_id:100+window.__nextAdminUserId};window.__adminUsers.push(user);return json({ok:true,id:user.id});
    }
    if(p==='/api/admin/domains')return json({ok:true,domains:[{id:1,domain:'skyfirst.io.vn',status:'verified',receive_enabled:1,send_enabled:0,verification_token:'smoke-token'}]});
    if(p==='/api/admin/aliases')return json({ok:true,aliases:[]});
    if(p==='/api/admin/audit')return json({ok:true,logs:[]});
    if(p==='/api/admin/system')return json({ok:true,storage:{messageBytes:0,messageCount:0},accounts:{users:window.__adminUsers.length},services:{sending:false,receivingConfigured:true,receivingEnabledDomains:1}});
    const userMatch=p.match(/^\/api\/admin\/users\/(\d+)$/);
    if(userMatch&&m==='PATCH'){
      const u0=window.__adminUsers.find(x=>x.id===Number(userMatch[1]));if(!u0)return json({ok:false,error:'Not found'},404);
      if('displayName'in b)u0.display_name=b.displayName;if('role'in b)u0.role=b.role;if('status'in b)u0.status=b.status;
      for(const [field,key] of [['allowNameChange','allow_name_change'],['allowAvatarChange','allow_avatar_change'],['allowPasswordChange','allow_password_change'],['allowSignatureChange','allow_signature_change'],['allowThemeChange','allow_theme_change']])if(field in b)u0[key]=+!!b[field];return json({ok:true});
    }
    if(userMatch&&m==='DELETE'){const id=Number(userMatch[1]);if(id===1)return json({ok:false,error:'Không thể xóa phiên hiện tại.'},400);const idx=window.__adminUsers.findIndex(x=>x.id===id);if(idx<0)return json({ok:false,error:'Not found'},404);window.__adminUsers.splice(idx,1);return json({ok:true,deleted:true,cleanupWarnings:0});}
    if(/^\/api\/admin\/users\/\d+\/reset-password$/.test(p)&&m==='POST')return json({ok:true});
    if(p.startsWith('/api/'))return json({ok:true,users:[],aliases:[],domains:[],logs:[],stats:{users:window.__adminUsers.length,activeMailboxes:window.__adminUsers.length,messages:0,bytes:0,unread:0},storage:{messageBytes:0},accounts:{users:window.__adminUsers.length},services:{sending:false,receivingConfigured:true,receivingEnabledDomains:1},operations:[],mailboxes:[],notifications:[],contacts:[],people:[],rules:[],templates:[],signatures:[],drafts:[]});
    return new Response('',{status:404});
   };`;
  const source=`(()=>{document.documentElement.lang='vi';document.head.innerHTML='<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin CRUD isolated smoke</title>';document.body.innerHTML='<div id="app"></div>';const st=document.createElement('style');st.textContent=${JSON.stringify(css)};document.head.appendChild(st);${fakeApi};const add=(code,wrap=false)=>{const el=document.createElement('script');el.textContent=wrap?'(()=>{\\n'+code+'\\n})()':code;document.body.appendChild(el)};add(${JSON.stringify(dialogs)});add(${JSON.stringify(app)},true);add(${JSON.stringify(v3)});add(${JSON.stringify(v4)});add(${JSON.stringify(v5)});return true})()`;
  const evalValue=async expression=>{const r=await cdp(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text||'Browser evaluation failed');return r.result?.value};
  const waitFor=async(expr,label)=>{const until=Date.now()+12000;while(Date.now()<until){try{if(await evalValue(expr))return}catch{}await new Promise(r=>setTimeout(r,60))}const diag=await evalValue("({body:(document.body.innerText||'').slice(0,1500),errors:window.__sfmErrors,apiCalls:window.__sfmApiCalls,users:window.__adminUsers})");throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diag)}`)};
  await evalValue(source);
  await waitFor("document.querySelector('#admin')&&document.querySelector('#rows')",'signed-in mailbox');
  await evalValue("document.querySelector('#admin').click();true");
  await waitFor("document.querySelector('[data-edit=\"2\"]')",'separate admin page and account list');
  const adminPage=await evalValue("({dedicated:!!document.querySelector('#adminWorkspace'),modalOverlayCount:document.querySelectorAll('.admin-page-wrap').length,accountRows:document.querySelectorAll('.admin-workspace .account-row').length})");
  if(!adminPage.dedicated||adminPage.modalOverlayCount!==0)throw new Error(`Admin page is still an overlay: ${JSON.stringify(adminPage)}`);
  // Edit must open a visible dialog and persist via PATCH.
  await evalValue("document.querySelector('[data-edit=\"2\"]').click();true");
  await waitFor("document.querySelector('.admin-dialog-wrap #save')",'edit account dialog');
  const dialogLayer=await evalValue("(()=>{const e=document.querySelector('.admin-dialog-wrap');return{z:getComputedStyle(e).zIndex,visible:!!e&&getComputedStyle(e).display!=='none',topmost:document.elementFromPoint(Math.min(innerWidth-20,e.getBoundingClientRect().left+60),Math.min(innerHeight-20,e.getBoundingClientRect().top+80))?.closest('.admin-dialog-wrap')!=null}})()");
  if(Number(dialogLayer.z)<900||!dialogLayer.visible||!dialogLayer.topmost)throw new Error(`Edit modal is covered or not clickable: ${JSON.stringify(dialogLayer)}`);
  await evalValue("document.querySelector('.admin-dialog-wrap #n').value='Tên đã sửa';document.querySelector('.admin-dialog-wrap #save').click();true");
  await waitFor("window.__adminUsers.find(x=>x.id===2)?.display_name==='Tên đã sửa'&&!document.querySelector('.admin-dialog-wrap')",'edit save request');
  // Single account creation via form.
  await evalValue("document.querySelector('#newu').click();true");await waitFor("document.querySelector('.admin-dialog-wrap #create')",'single create dialog');
  await evalValue("document.querySelector('.admin-dialog-wrap #n').value='Tài khoản mới';document.querySelector('.admin-dialog-wrap #local').value='new.account';document.querySelector('.admin-dialog-wrap #p').value='Password123!';document.querySelector('.admin-dialog-wrap #create').click();true");
  await waitFor("window.__adminUsers.some(x=>x.email==='new.account@skyfirst.io.vn')&&!document.querySelector('.admin-dialog-wrap')",'single create API request');
  const singleId=await evalValue("window.__adminUsers.find(x=>x.email==='new.account@skyfirst.io.vn').id");
  // Delete from the edit dialog and confirm through the in-page dialog, not the browser.
  await waitFor(`document.querySelector('[data-edit="${singleId}"]')`,'created account row');
  await evalValue(`document.querySelector('[data-edit="${singleId}"]').click();true`);await waitFor("document.querySelector('.admin-dialog-wrap #deleteUser')",'delete button in edit dialog');
  await evalValue("document.querySelector('.admin-dialog-wrap #deleteUser').click();true");await waitFor("document.querySelector('.inline-confirm [data-yes]')",'in-app delete confirmation');await evalValue("document.querySelector('.inline-confirm [data-yes]').click();true");
  await waitFor(`!window.__adminUsers.some(x=>x.id===${singleId})&&!document.querySelector('.admin-dialog-wrap')`,'single account deletion');
  // Bulk creation in a real form handler (mocked requests only).
  await evalValue("document.querySelector('#bulkCreateUsers').click();true");await waitFor("document.querySelector('.admin-dialog-wrap #bulkRows')",'bulk create dialog');
  await evalValue("document.querySelector('.admin-dialog-wrap #bulkRows').value='Nhân sự hàng loạt A | bulk.a | Password123!\\nNhân sự hàng loạt B | bulk.b | Password123!';document.querySelector('.admin-dialog-wrap #runBulkCreate').click();true");
  await waitFor("window.__adminUsers.some(x=>x.email==='bulk.a@skyfirst.io.vn')&&window.__adminUsers.some(x=>x.email==='bulk.b@skyfirst.io.vn')&&!document.querySelector('.admin-dialog-wrap')",'bulk account creation');
  const bulkIds=await evalValue("window.__adminUsers.filter(x=>['bulk.a@skyfirst.io.vn','bulk.b@skyfirst.io.vn'].includes(x.email)).map(x=>x.id)");
  // Bulk delete: select both, confirm once, then verify each DELETE and list refresh.
  await evalValue(`(()=>{for(const id of ${JSON.stringify(bulkIds)}){const c=document.querySelector('[data-user-select="'+id+'"]');if(c)c.checked=true}document.querySelector('#bulkDeleteUsers').click();return true})()`);
  await waitFor("document.querySelector('.inline-confirm [data-yes]')",'bulk deletion confirmation');await evalValue("document.querySelector('.inline-confirm [data-yes]').click();true");
  await waitFor(`!${JSON.stringify(bulkIds)}.some(id=>window.__adminUsers.some(x=>x.id===id))`,'bulk account deletion');
  const final=await evalValue("({users:window.__adminUsers.map(x=>x.email),calls:window.__sfmApiCalls.filter(x=>x.path.startsWith('/api/admin/users')).map(x=>x.method+' '+x.path),errors:window.__sfmErrors,nativeDialogs:window.__nativeDialogs,modalClasses:[...document.querySelectorAll('.modal-wrap')].map(x=>x.className),adminStillDedicated:!!document.querySelector('#adminWorkspace')})");
  if(final.errors.length)throw new Error(`Frontend JS errors: ${JSON.stringify(final.errors)}`);
  if(final.nativeDialogs.length)throw new Error(`Native browser dialogs were used: ${JSON.stringify(final.nativeDialogs)}`);
  for(const expected of ['PATCH /api/admin/users/2','POST /api/admin/users','DELETE /api/admin/users/'+singleId])if(!final.calls.includes(expected))throw new Error(`Expected CRUD request missing ${expected}`);
  if(bulkIds.some(id=>final.users.includes(`bulk.${id}@skyfirst.io.vn`))){} // state assertion is performed above by id.
  console.log(JSON.stringify({result:'PASS',mode:'Real Chromium DOM/CSS and actual UI event handlers, isolated mock API; production not contacted',checks:{dedicatedAdminPage:adminPage,editDialogLayer:dialogLayer,editSave:true,singleCreate:true,singleDelete:true,bulkCreate:bulkIds.length,bulkDelete:true,noNativeDialogs:final.nativeDialogs.length===0,noJavaScriptErrors:final.errors.length===0},final},null,2));
 }finally{
  try{ws?.close()}catch{}if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(r=>setTimeout(r,250))}await fsp.rm(profile,{recursive:true,force:true}).catch(()=>{});
 }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
