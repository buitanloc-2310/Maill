import {test} from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';
import {database} from './db.mjs';
import {buildMime,cleanEmailHtml,parseStoredMessage} from '../src/lib/mail.js';
import {hashPassword} from '../src/lib/security.js';
const db=database(),objects=new Map();let failStorage=false,providerCalls=0,providerMode='ok',lastPayload;
const env={DB:db,SETUP_SECRET:'test-setup-secret-for-local-tests-only-2026',RESEND_API_KEY:'test-key-not-real',RESEND_WEBHOOK_SECRET:'test-webhook-secret-2026',MAIL_STORAGE:{async put(k,v){if(failStorage)throw Error('Storage offline');objects.set(k,v)},async get(k){const value=objects.get(k);return value?{arrayBuffer:async()=>value}:null},async delete(k){objects.delete(k)}}};
let cookie='';
async function request(url,method='GET',body,headers={}){const h={'x-sfm-request':'1',cookie,...headers};if(body&&!(body instanceof FormData))h['content-type']='application/json';const r=await app.fetch(new Request('https://mail.skyfirst.io.vn'+url,{method,headers:h,body:body instanceof FormData?body:body?JSON.stringify(body):undefined}),env);return {r,data:await r.json()};}
function compose(key,to='reader@skyfirst.io.vn'){const f=new FormData();f.set('requestId',key);f.set('mailboxId','1');f.set('to',to);f.set('subject','Kiểm thử tiếng Việt');f.set('text','Nội dung thư');return f;}
test('mail API and persisted delivery',async t=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://cloudflare-dns.com/dns-query')){
   const u=new URL(url),name=u.searchParams.get('name')||'',type=u.searchParams.get('type')||'';
   if(type==='MX')return Response.json({Answer:[{data:'10 route1.mx.cloudflare.net.'}]});
   if(name.startsWith('_skyfirst-mail.'))return Response.json({Answer:[{data:'"skyfirst-mail-verification=test-dns-token"'}]});
   if(name.startsWith('resend._domainkey.'))return Response.json({Answer:[{data:'"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ"'}]});
   if(name.startsWith('_dmarc.'))return Response.json({Answer:[{data:'"v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@skyfirst.io.vn"'}]});
   if(name.startsWith('default._bimi.'))return Response.json({Answer:[{data:'"v=BIMI1; l=https://mail.skyfirst.io.vn/bimi-logo.svg; a=https://mail.skyfirst.io.vn/vmc.pem"'}]});
   return Response.json({Answer:[{data:'"v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all"'}]});
  }
  assert.equal(url,'https://api.resend.com/emails');providerCalls++;lastPayload=JSON.parse(opts.body);assert.ok(opts.headers['Idempotency-Key']);if(providerMode==='timeout')throw Error('Connection lost');return Response.json({id:'provider-'+providerCalls});
 };
 try{
 await t.test('bootstrap locked, correct secret creates root',async()=>{const b={email:'admin@skyfirst.io.vn',displayName:'Root',password:'mail-test-password'};assert.equal((await request('/api/bootstrap','POST',b)).r.status,403);const x=await request('/api/bootstrap','POST',b,{'x-setup-secret':env.SETUP_SECRET});assert.equal(x.r.status,200);cookie=x.r.headers.get('set-cookie').split(';')[0];const p=await hashPassword('reader-password');db.sql.prepare('INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations) VALUES(?,?,?,?,?)').run('reader@skyfirst.io.vn','Reader',p.salt,p.hash,p.iterations);db.sql.exec("INSERT INTO mailboxes(user_id,address,display_name) VALUES(2,'reader@skyfirst.io.vn','Reader')");});
 await t.test('cross-site writes blocked',async()=>assert.equal((await request('/api/logout','POST',{}, {origin:'https://evil.test'})).r.status,403));
 await t.test('internal send commits both mailboxes once',async()=>{const x=await request('/api/compose','POST',compose('internal-00000001'));assert.equal(x.r.status,200,JSON.stringify(x.data));assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,2);const again=await request('/api/compose','POST',compose('internal-00000001'));assert.equal(again.r.status,200);assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,2);assert.equal(providerCalls,0)});
 await t.test('same id cannot change content',async()=>{const f=compose('internal-00000001');f.set('subject','Changed');assert.equal((await request('/api/compose','POST',f)).r.status,409)});
 await t.test('R2 failure occurs before external send',async()=>{db.sql.exec("UPDATE managed_domains SET send_enabled=1 WHERE domain='skyfirst.io.vn'");failStorage=true;const x=await request('/api/compose','POST',compose('storage-fail-0001','external@example.test'));failStorage=false;assert.equal(x.r.status,502);assert.equal(providerCalls,0)});
 await t.test('inline images reach provider; BCC absent from MIME headers',async()=>{const f=compose('external-inline01','external@example.test');f.set('bcc','hidden@example.test');f.set('html','<p><img src="cid:logo-one"></p>');f.append('inlineAttachments',new File([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3])],'logo.png',{type:'image/png'}));f.set('inlineCidMap',JSON.stringify([{name:'logo.png',cid:'logo-one'}]));const x=await request('/api/compose','POST',f);assert.equal(x.r.status,200,JSON.stringify(x.data));assert.equal(providerCalls,1);assert.equal(lastPayload.attachments[0].content_id,'logo-one');const op=db.sql.prepare('SELECT * FROM send_operations WHERE id=?').get(x.data.operationId);assert.ok(!new TextDecoder().decode(objects.get(op.storage_key)).includes('Bcc:'));});
 await t.test('provider timeout blocks dangerous resend',async()=>{providerMode='timeout';const x=await request('/api/compose','POST',compose('uncertain-000001','external@example.test'));assert.equal(x.data.status,'uncertain');const calls=providerCalls;assert.equal((await request('/api/compose','POST',compose('uncertain-000001','external@example.test'))).r.status,409);assert.equal(providerCalls,calls);providerMode='ok';});
 await t.test('admin cannot create a Super Admin or reset the Super Admin password',async()=>{
  const hp=await hashPassword('staff-admin-password');
  db.sql.prepare(`INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations,role,status) VALUES(?,?,?,?,?,'admin','active')`).run('staff@skyfirst.io.vn','Staff Admin',hp.salt,hp.hash,hp.iterations);
  db.sql.prepare(`INSERT INTO mailboxes(user_id,address,display_name,is_primary,is_active) VALUES(3,'staff@skyfirst.io.vn','Staff Admin',1,1)`).run();
  const rootCookie=cookie,login=await request('/api/login','POST',{email:'staff@skyfirst.io.vn',password:'staff-admin-password'});
  assert.equal(login.r.status,200);cookie=login.r.headers.get('set-cookie').split(';')[0];
  const elevated=await request('/api/admin/users','POST',{displayName:'Escalation Attempt',email:'elevated@skyfirst.io.vn',password:'strong-password-123',role:'super_admin'});
  assert.equal(elevated.r.status,403);
  const patchedElevation=await request('/api/admin/users/2','PATCH',{role:'admin'});
  assert.equal(patchedElevation.r.status,403,'admin must not elevate a regular user through PATCH');
  const reset=await request('/api/admin/users/1/reset-password','POST',{password:'new-super-admin-password'});
  assert.equal(reset.r.status,403);cookie=rootCookie;
 });
 await t.test('login rate limit blocks the eleventh attempt within the window',async()=>{
  let result;
  for(let i=0;i<11;i++)result=await request('/api/login','POST',{email:'unknown-rate-limit@skyfirst.io.vn',password:'wrong-password'},{'CF-Connecting-IP':'203.0.113.90'});
  assert.equal(result.r.status,429);assert.equal(result.r.headers.get('retry-after'),'900');
 });
 await t.test('reader cannot fetch another mailbox message or attach a rule to another mailbox',async()=>{const login=await request('/api/login','POST',{email:'reader@skyfirst.io.vn',password:'reader-password'});const rootCookie=cookie;cookie=login.r.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/messages/1')).r.status,404);assert.equal((await request('/api/admin/send-operations')).r.status,403);assert.equal((await request('/api/rules','POST',{name:'Cross-mailbox attempt',mailboxId:1,actionFolder:'spam'})).r.status,400);assert.equal((await request('/api/rules','POST',{name:'Owned mailbox rule',mailboxId:2,actionFolder:'archive'})).data.ok,true);const rule=db.sql.prepare('SELECT mailbox_id,action_folder FROM mail_rules WHERE user_id=2 ORDER BY id DESC LIMIT 1').get();assert.equal(rule.mailbox_id,2);assert.equal(rule.action_folder,null,'unsupported inbound folder actions are ignored');cookie=rootCookie;});
 await t.test('domain disabled remains disabled',async()=>{db.sql.exec("UPDATE managed_domains SET send_enabled=0 WHERE domain='skyfirst.io.vn'");assert.equal((await request('/api/compose','POST',compose('disabled-0000001','external@example.test'))).r.status,400)});
 await t.test('inbound retries de-duplicate atomically and normalize RFC date',async()=>{const raw=await buildMime({from:'other@example.test',to:['reader@skyfirst.io.vn'],subject:'Mail inbound',text:'Hello',messageId:'<inbound-test@example.test>'});const before=db.sql.prepare('SELECT count(*) n FROM messages').get().n;let rejected;for(let i=0;i<2;i++){await app.email({from:'other@example.test',to:'reader@skyfirst.io.vn',headers:new Headers({subject:'Mail inbound',date:'Mon, 05 Oct 2026 10:00:00 +0700','message-id':'<inbound-test@example.test>'}),raw:new Response(raw).body,rawSize:raw.byteLength,setReject:s=>{rejected=s}},env,{});}assert.equal(rejected,undefined);assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,before+1);assert.equal(db.sql.prepare("SELECT sent_at FROM messages WHERE message_id_header='<inbound-test@example.test>'").get().sent_at,'2026-10-05T03:00:00.000Z');assert.equal(db.sql.prepare('SELECT count(*) n FROM inbound_receipts WHERE mailbox_id=2').get().n,1)});
 await t.test('inbound duplicate without Message-ID de-duplicates by raw content digest',async()=>{const raw=await buildMime({from:'other@example.test',to:['reader@skyfirst.io.vn'],subject:'No message id',text:'Same raw body'});const before=db.sql.prepare('SELECT count(*) n FROM messages').get().n;for(let i=0;i<2;i++)await app.email({from:'other@example.test',to:'reader@skyfirst.io.vn',headers:new Headers({subject:'No message id',date:'Mon, 05 Oct 2026 10:00:00 +0700'}),raw:new Response(raw).body,rawSize:raw.byteLength,setReject:()=>{}},env,{});assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,before+1)});
 await t.test('inbound is rejected when domain receiving is disabled',async()=>{db.sql.exec("UPDATE managed_domains SET receive_enabled=0 WHERE domain='skyfirst.io.vn'");const raw=await buildMime({from:'other@example.test',to:['reader@skyfirst.io.vn'],subject:'Disabled receive',text:'Hello'});let rejected;const before=db.sql.prepare('SELECT count(*) n FROM messages').get().n;await app.email({from:'other@example.test',to:'reader@skyfirst.io.vn',headers:new Headers({subject:'Disabled receive'}),raw:new Response(raw).body,rawSize:raw.byteLength,setReject:s=>{rejected=s}},env,{});assert.ok(rejected);assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,before);db.sql.exec("UPDATE managed_domains SET receive_enabled=1 WHERE domain='skyfirst.io.vn'")});
 await t.test('cursor pagination does not repeat messages',async()=>{const first=await request('/api/messages?folder=sent&limit=1');assert.equal(first.data.messages.length,1);assert.ok(first.data.nextCursor);const next=await request('/api/messages?folder=sent&limit=1&before='+first.data.nextCursor);assert.notEqual(first.data.messages[0].id,next.data.messages[0].id)});

 // V13 New Enterprise Tests: Blue Tick Verification, BIMI/DNS, Undo Send, Message Recall, Anti-Spam/Risk/Suppression, Send-As Delegation
 await t.test('Blue Tick verification is admin-controlled, logged, and prevents user self-verification or badge spoofing',async()=>{
  const rootCookie=cookie;
  const readerLogin=await request('/api/login','POST',{email:'reader@skyfirst.io.vn',password:'reader-password'});
  cookie=readerLogin.r.headers.get('set-cookie').split(';')[0];
  // Regular user cannot grant themselves blue tick or spoof checkmark in display name
  assert.equal((await request('/api/admin/users/2/verify','POST',{action:'grant',reason:'Self verify'})).r.status,403);
  assert.equal((await request('/api/profile/name','PATCH',{displayName:'Reader ✓ [Tích xanh]'})).r.status,400);
  cookie=rootCookie;
  // Admin grants Blue Tick verification to user 1 (admin@skyfirst.io.vn)
  const grant=await request('/api/admin/users/1/verify','POST',{action:'grant',accountType:'organization',department:'Ban Điều hành Sky First',reason:'Xác minh danh tính quản trị chính thức'});
  assert.equal(grant.r.status,200);
  assert.equal(grant.data.isVerified,true);
  assert.equal(grant.data.verificationStatus,'verified');
  const verList=await request('/api/admin/verifications?q=admin@skyfirst.io.vn');
  assert.equal(verList.r.status,200);
  assert.equal(verList.data.verifiedAccounts.length,1);
  assert.equal(verList.data.history.length,1);
  // Message list and reader reflect verified status for user 1
  const listRes=await request('/api/messages?folder=sent&limit=5');
  assert.equal(listRes.data.messages[0].sender_verification?.isVerified,true);
  assert.equal(listRes.data.messages[0].sender_verification?.department,'Ban Điều hành Sky First');
 });

 await t.test('Undo Send holds message in queue before external/internal delivery and cancels cleanly',async()=>{
  const f=compose('undo-hold-test-001','reader@skyfirst.io.vn');
  f.set('undoHoldSeconds','10');
  const held=await request('/api/compose','POST',f);
  assert.equal(held.r.status,200);
  assert.equal(held.data.queued,true);
  assert.equal(held.data.status,'undo_window');
  const undoRes=await request(`/api/send-queue/${held.data.operationId}/undo`,'POST',{});
  assert.equal(undoRes.r.status,200);
  assert.equal(undoRes.data.undone,true);
  // Already completed message cannot be undone
  const alreadySentUndo=await request('/api/send-queue/1_internal-00000001/undo','POST',{});
  assert.equal(alreadySentUndo.r.status,409);
 });

 await t.test('Internal email recall revokes recipient copy and hides body while external recipient reports cannot_recall_external',async()=>{
  // Send a fresh internal message from admin (1) to reader (2)
  const sent=await request('/api/compose','POST',compose('recall-internal-01','reader@skyfirst.io.vn'));
  assert.equal(sent.r.status,200);
  const senderMsg=db.sql.prepare("SELECT id FROM messages WHERE mailbox_id=1 AND direction='outbound' ORDER BY id DESC LIMIT 1").get();
  const readerMsg=db.sql.prepare("SELECT id FROM messages WHERE mailbox_id=2 AND direction='inbound' ORDER BY id DESC LIMIT 1").get();
  // Recall the sent message
  const rec=await request(`/api/messages/${senderMsg.id}/recall`,'POST',{reason:'Gửi nhầm tài liệu nội bộ'});
  assert.equal(rec.r.status,200);
  assert.equal(rec.data.overallStatus,'recalled');
  assert.equal(rec.data.recalledCount,1);
  // Verify reader cannot view original content of recalled message
  const rootCookie=cookie;
  const readerLogin=await request('/api/login','POST',{email:'reader@skyfirst.io.vn',password:'reader-password'});
  cookie=readerLogin.r.headers.get('set-cookie').split(';')[0];
  const opened=await request(`/api/messages/${readerMsg.id}`);
  assert.equal(opened.r.status,200);
  assert.equal(opened.data.message.status,'recalled');
  assert.doesNotMatch(opened.data.message.parsed.text,/Nội dung thư/);
  assert.match(opened.data.message.parsed.text,/thu hồi/);
  cookie=rootCookie;
 });

 await t.test('Send-As delegation allows authorized sending from another mailbox without granting inbox read access',async()=>{
  // Grant staff@skyfirst.io.vn (user 3) permission to send as admin@skyfirst.io.vn (mailbox 1)
  const grantDel=await request('/api/admin/delegations','POST',{mailboxId:1,granteeUserId:3,allowedAddress:'admin@skyfirst.io.vn',permissionMode:'send_on_behalf',purpose:'Phối hợp đối ngoại'});
  assert.equal(grantDel.r.status,200);
  const rootCookie=cookie;
  const staffLogin=await request('/api/login','POST',{email:'staff@skyfirst.io.vn',password:'staff-admin-password'});
  cookie=staffLogin.r.headers.get('set-cookie').split(';')[0];
  const ids=await request('/api/sender-identities');
  assert.equal(ids.data.delegations.length,1);
  assert.equal(ids.data.delegations[0].address,'admin@skyfirst.io.vn');
  // Staff sends using delegated address admin@skyfirst.io.vn
  const f=new FormData();f.set('requestId','delegated-send-001');f.set('mailboxId','3');f.set('senderAddress','admin@skyfirst.io.vn');f.set('to','reader@skyfirst.io.vn');f.set('subject','Thư gửi thay');f.set('text','Nội dung ủy quyền');
  const sendDel=await request('/api/compose','POST',f);
  assert.equal(sendDel.r.status,200,JSON.stringify(sendDel.data));
  assert.equal(sendDel.data.senderKind,'delegated');
  // Staff still CANNOT read mailbox 1's messages
  assert.equal((await request('/api/messages/1')).r.status,404);
  cookie=rootCookie;
 });

 await t.test('Anti-spam risk engine blocks dangerous executable attachments and suppressed recipients',async()=>{
  const badFileForm=compose('risk-exe-block-0001','reader@skyfirst.io.vn');
  badFileForm.append('attachments',new File(['MZ-malware'],'invoice.pdf.exe',{type:'application/octet-stream'}));
  const blockedExe=await request('/api/compose','POST',badFileForm);
  assert.equal(blockedExe.r.status,400);
  assert.match(blockedExe.data.error,/rủi ro cao|thực thi nguy hiểm/);
  // Webhook hard bounce automatically suppresses recipient
  const wh=await request('/api/webhooks/resend','POST',{type:'email.bounced',data:{email_id:'provider-1',to:['bounced-user@example.test']}},{'x-webhook-secret':env.RESEND_WEBHOOK_SECRET});
  assert.equal(wh.r.status,200);
  db.sql.exec("UPDATE managed_domains SET send_enabled=1 WHERE domain='skyfirst.io.vn'");
  const toSuppressed=await request('/api/compose','POST',compose('suppressed-test-01','bounced-user@example.test'));
  assert.equal(toSuppressed.r.status,400);
  assert.match(toSuppressed.data.error,/bị trả lại vĩnh viễn|danh sách chặn/);
 });

 await t.test('Domain BIMI/SPF/DKIM/DMARC check and safe domain deletion with dependents',async()=>{
  db.sql.exec("UPDATE managed_domains SET verification_token='test-dns-token' WHERE id=1");
  const check=await request('/api/admin/domains/1/verify','POST',{});
  assert.equal(check.r.status,200);
  assert.equal(check.data.verified,true);
  assert.equal(check.data.health.spf.ok,true);
  assert.equal(check.data.health.dkim.ok,true);
  assert.equal(check.data.health.dmarc.bimiEligible,true);
  assert.equal(check.data.health.bimi.vmcConfigured,true);
  assert.equal(check.data.health.externalStatus,'verified_dns');
 });

 await t.test('deleting recipient preserves shared sender MIME and removes account-owned rows',async()=>{
  const row=db.sql.prepare("SELECT storage_key FROM messages WHERE mailbox_id=1 AND subject='Kiểm thử tiếng Việt' ORDER BY id LIMIT 1").get();
  const orphanKey='messages/outbound/reader-owned-orphan.eml';objects.set(orphanKey,new Uint8Array([1,2,3]));
  db.sql.prepare(`INSERT INTO send_operations(id,user_id,request_hash,status,storage_key) VALUES(?,?,?,'completed',?)`).run('reader-owned-send-op',2,'reader-owned-hash',orphanKey);
  const x=await request('/api/admin/users/2','DELETE',{confirmEmail:'reader@skyfirst.io.vn'});assert.equal(x.r.status,200,JSON.stringify(x.data));
  assert.ok(objects.has(row.storage_key),'shared MIME must remain because the sender still owns a message reference');
  assert.equal(objects.has(orphanKey),false,'unreferenced account-owned MIME should be removed');
  assert.equal(db.sql.prepare('SELECT count(*) n FROM send_operations WHERE user_id=2').get().n,0);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM messages WHERE mailbox_id IS NULL').get().n,0,'account deletion must not leave orphaned message rows');
 });
 await t.test('Sky First Verified public portal and API independently verify sender and domain status',async()=>{
  const pubApi=await request('/api/public/verified?address=admin@skyfirst.io.vn');
  assert.equal(pubApi.r.status,200);
  assert.equal(pubApi.data.ok,true);
  assert.equal(pubApi.data.service,'Sky First Verified');
  assert.equal(pubApi.data.account.isVerified,true);
  assert.equal(pubApi.data.account.verificationStatus,'verified');
  assert.equal(pubApi.data.domain.domain,'skyfirst.io.vn');
  assert.match(pubApi.data.domain.bimiRecord,/v=BIMI1/);

  const pubHtml=await app.fetch(new Request('https://mail.skyfirst.io.vn/verified?address=admin@skyfirst.io.vn'),env,{waitUntil:()=>null});
  assert.equal(pubHtml.status,200);
  const htmlText=await pubHtml.text();
  assert.match(htmlText,/Sky First Verified/);
  assert.match(htmlText,/Đã xác minh chính thức/);
  assert.match(htmlText,/skyfirst\.io\.vn/);
 });

 await t.test('expired session on current day rejected',async()=>{db.sql.exec("UPDATE sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')");assert.equal((await request('/api/me')).r.status,401)});
 }finally{globalThis.fetch=originalFetch;}
});
test('HTML parser strips executable markup and preserves table formatting',()=>{const clean=cleanEmailHtml('<table><tr><td style="color:red">Xin chào</td></tr></table><img src=x onerror=alert(1)><svg onload=alert(1)><script>x</script></svg><a href="jav&#x61;script:alert(1)">click</a><iframe srcdoc="x"></iframe>');assert.match(clean,/<table>/);assert.match(clean,/color:red/);assert.doesNotMatch(clean,/onerror|onload|javascript:|<script|<svg|<iframe/)});
test('MIME Vietnamese subject and attachment bytes roundtrip',async()=>{const raw=await buildMime({from:'a@example.test',to:['b@example.test'],subject:'Thư tiếng Việt',text:'Xin chào',attachments:[new File(['Dữ liệu'],'data.txt',{type:'text/plain'})]});objects.set('roundtrip',raw);const parsed=await parseStoredMessage(env,'roundtrip');assert.equal(parsed.subject,'Thư tiếng Việt');assert.equal(new TextDecoder().decode(parsed.attachments[0].content),'Dữ liệu')});
