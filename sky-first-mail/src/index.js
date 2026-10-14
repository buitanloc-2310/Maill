import { json, bodyJson, badRequest, unauthorized, forbidden, notFound } from './lib/http.js';
import { hashPassword, verifyPassword } from './lib/security.js';
import { createSession, currentUser, destroySession, isAdmin } from './lib/auth.js';
import { parseStoredMessage, cleanEmailHtml, buildMime } from './lib/mail.js';
import { reliableCompose } from './lib/compose.js';
import { RELIABILITY_STATEMENTS, digest, boundedRequest } from './lib/reliability.js';
import { isAllowedAvatarImage, safeAttachmentResponse } from './lib/content-policy.js';
import { sendExternal } from './lib/transport.js';
import { readStreamBounded } from './lib/stream-limit.js';

const FOLDERS=['inbox','sent','drafts','spam','trash','archive'];
const ROLES=['user','admin','super_admin'];
const normalizeEmail=v=>String(v||'').trim().toLowerCase();
function normalizeContentId(value){
  let cid=String(value||'').trim().replace(/^cid:/i,'').replace(/&lt;|&#x0*3c;|&#0*60;/gi,'<').replace(/&gt;|&#x0*3e;|&#0*62;/gi,'>');
  try{cid=decodeURIComponent(cid)}catch{}
  return cid.replace(/[<>\s]/g,'').toLowerCase();
}
function normalizeMessageDate(value){
  if(!value)return null;
  const timestamp=Date.parse(String(value));
  return Number.isFinite(timestamp)?new Date(timestamp).toISOString():null;
}
const validEmail=v=>String(v||'').length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v||'');
const boolInt=v=>v?1:0;
const SCHEMA_BOOTSTRAP_VERSION='12.0.5';
const safeRole=v=>ROLES.includes(v)?v:'user';
const parseJson=(v,fallback=[])=>{try{return JSON.parse(v??'')}catch{return fallback}};
function constantTimeEqual(a,b){
  const left=new TextEncoder().encode(String(a??'')),right=new TextEncoder().encode(String(b??''));
  let diff=left.length^right.length;const n=Math.max(left.length,right.length);
  for(let i=0;i<n;i++)diff|=(left[i%Math.max(left.length,1)]||0)^(right[i%Math.max(right.length,1)]||0);
  return diff===0;
}

let schemaReady=false,schemaPromise=null;
async function ensureColumns(env,table,columns){
  // One PRAGMA round-trip per table, instead of one per column. Table/column names
  // and definitions are static source constants, never request-controlled.
  const r=await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const existing=new Set((r.results||[]).map(x=>x.name));
  const missing=columns.filter(([name])=>!existing.has(name));
  if(missing.length)await env.DB.exec(missing.map(([name,definition])=>`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`).join('\n'));
}
async function ensureSchema(env){
  if(schemaReady)return;
  if(schemaPromise)return schemaPromise;
  // Several first requests may hit a fresh Worker isolate at once. Share one schema
  // initialization promise so they do not race PRAGMA/ALTER TABLE operations.
  schemaPromise=(async()=>{
   try{
    // D1 is shared across Worker isolates, while schemaReady is isolate-local.
    // A durable version marker lets a cold isolate skip the expensive compatibility
    // DDL/PRAGMA path after the schema has been prepared once.
    try{
      const marker=await env.DB.prepare(`SELECT value_json FROM settings WHERE key='runtime_schema_version' LIMIT 1`).first();
      if(marker?.value_json===JSON.stringify(SCHEMA_BOOTSTRAP_VERSION)){schemaReady=true;return;}
    }catch{}
    await env.DB.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_iterations INTEGER NOT NULL DEFAULT 100000,role TEXT NOT NULL DEFAULT 'user',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS mailboxes (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,address TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT,is_primary INTEGER NOT NULL DEFAULT 1,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,mailbox_id INTEGER,direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),folder TEXT NOT NULL DEFAULT 'inbox',message_id_header TEXT,thread_key TEXT,sender TEXT NOT NULL,recipients_json TEXT NOT NULL,cc_json TEXT,bcc_json TEXT,subject TEXT,preview TEXT,storage_key TEXT NOT NULL,raw_size INTEGER NOT NULL DEFAULT 0,is_read INTEGER NOT NULL DEFAULT 0,is_starred INTEGER NOT NULL DEFAULT 0,is_important INTEGER NOT NULL DEFAULT 0,snoozed_until TEXT,content_sha256 TEXT,hash_recorded_at TEXT,status TEXT NOT NULL DEFAULT 'received',sent_at TEXT,received_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT,message_id INTEGER NOT NULL,filename TEXT NOT NULL,content_type TEXT,size INTEGER NOT NULL DEFAULT 0,storage_key TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT NOT NULL,target_type TEXT,target_id TEXT,metadata_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS login_history (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,ip TEXT,user_agent TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS aliases (id INTEGER PRIMARY KEY AUTOINCREMENT,mailbox_id INTEGER NOT NULL,address TEXT NOT NULL UNIQUE COLLATE NOCASE,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id INTEGER PRIMARY KEY,theme TEXT NOT NULL DEFAULT 'system',density TEXT NOT NULL DEFAULT 'comfortable',reading_pane TEXT NOT NULL DEFAULT 'right',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER NOT NULL,email TEXT NOT NULL COLLATE NOCASE,display_name TEXT,notes TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_user_id,email),FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS signatures (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,mailbox_id INTEGER,name TEXT NOT NULL,content_html TEXT NOT NULL DEFAULT '',is_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,name),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS message_labels (message_id INTEGER NOT NULL,label_id INTEGER NOT NULL,PRIMARY KEY(message_id,label_id),FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS mail_rules (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,mailbox_id INTEGER,name TEXT NOT NULL,sender_contains TEXT,subject_contains TEXT,action_folder TEXT,action_star INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,type TEXT NOT NULL DEFAULT 'system',title TEXT NOT NULL,body TEXT,is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS compose_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,mailbox_id INTEGER NOT NULL,to_json TEXT NOT NULL DEFAULT '[]',cc_json TEXT NOT NULL DEFAULT '[]',subject TEXT,body_text TEXT,storage_key TEXT,attachment_names_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS managed_domains (id INTEGER PRIMARY KEY AUTOINCREMENT,domain TEXT NOT NULL UNIQUE COLLATE NOCASE,status TEXT NOT NULL DEFAULT 'configured',receive_enabled INTEGER NOT NULL DEFAULT 1,send_enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS mail_templates (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,name TEXT NOT NULL,subject TEXT NOT NULL DEFAULT '',body_html TEXT NOT NULL DEFAULT '',body_text TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT 'personal',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS delivery_events (id INTEGER PRIMARY KEY AUTOINCREMENT,message_id INTEGER,provider TEXT NOT NULL DEFAULT 'resend',provider_message_id TEXT,event_type TEXT NOT NULL,detail_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder ON messages(mailbox_id,folder,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);
    CREATE INDEX IF NOT EXISTS idx_login_history_user_created ON login_history(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_user_id,display_name);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,is_read,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compose_drafts_user ON compose_drafts(user_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rules_user ON mail_rules(user_id,is_active);
    CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id,name);
    CREATE INDEX IF NOT EXISTS idx_mail_templates_user ON mail_templates(user_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(message_id,created_at DESC);
    INSERT OR IGNORE INTO settings(key,value_json) VALUES ('setup_completed','false'),('mail_domain','"skyfirst.io.vn"'),('app_name','"Sky First Mail"');
    INSERT OR IGNORE INTO managed_domains(domain,status,receive_enabled,send_enabled) VALUES('skyfirst.io.vn','configured',1,0);
    INSERT OR IGNORE INTO managed_domains(domain,status,receive_enabled,send_enabled) VALUES('nhahanngu.io.vn','configured',1,0);
  `);
  if(typeof env.DB.batch==='function')await env.DB.batch(RELIABILITY_STATEMENTS.map(statement=>env.DB.prepare(statement)));
  else for(const statement of RELIABILITY_STATEMENTS)await env.DB.prepare(statement).run();
  for(const [table,columns] of [
    ['users',[['avatar_key','TEXT'],['allow_name_change','INTEGER NOT NULL DEFAULT 1'],['allow_avatar_change','INTEGER NOT NULL DEFAULT 1'],['allow_password_change','INTEGER NOT NULL DEFAULT 1'],['last_login_at','TEXT'],['cover_key','TEXT'],['profile_status',"TEXT NOT NULL DEFAULT 'available'"],['allow_signature_change','INTEGER NOT NULL DEFAULT 1'],['allow_theme_change','INTEGER NOT NULL DEFAULT 1']]],
    ['sessions',[['ip','TEXT'],['user_agent','TEXT'],['last_seen_at','TEXT']]],
    ['messages',[['bcc_json','TEXT'],['is_important','INTEGER NOT NULL DEFAULT 0'],['snoozed_until','TEXT'],['content_sha256','TEXT'],['hash_recorded_at','TEXT']]],
    ['compose_drafts',[['bcc_json',"TEXT NOT NULL DEFAULT '[]'"],['body_html','TEXT'],['sender_address','TEXT'],['reply_to_message_id','INTEGER']]],
    ['managed_domains',[['transport',"TEXT NOT NULL DEFAULT 'resend'"],['verification_token','TEXT'],['verified_at','TEXT'],['last_checked_at','TEXT'],['health_json','TEXT'],['inbound_adapter',"TEXT NOT NULL DEFAULT 'cloudflare_email_routing'"]]]
  ])await ensureColumns(env,table,columns);
    // Domain send state is explicit; never auto-enable every domain because one provider secret exists.
    await env.DB.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('runtime_schema_version',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).bind(JSON.stringify(SCHEMA_BOOTSTRAP_VERSION)).run();
    schemaReady=true;
   }catch(error){
    schemaPromise=null;
    throw error;
   }
  })();
  return schemaPromise;
}

async function audit(env,userId,action,targetType=null,targetId=null,metadata={}){
  try{await env.DB.prepare(`INSERT INTO audit_logs(user_id,action,target_type,target_id,metadata_json) VALUES(?,?,?,?,?)`).bind(userId||null,action,targetType,targetId==null?null:String(targetId),JSON.stringify(metadata||{})).run()}catch{}
}
async function dnsJson(name,type){
  const r=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,{headers:{accept:'application/dns-json'}});
  if(!r.ok)throw new Error(`DNS lookup HTTP ${r.status}`);return r.json();
}
async function domainHealth(domain){
  const [txt,mx]=await Promise.all([dnsJson(`_skyfirst-mail.${domain.domain}`,'TXT'),dnsJson(domain.domain,'MX')]);
  const token=`skyfirst-mail-verification=${domain.verification_token||''}`;
  // DNS TXT answers may show adjacent quoted chunks; join those chunks before an exact match.
  // Substring matching is unsafe because a token embedded in an unrelated TXT value must not verify ownership.
  const txtValues=(txt.Answer||[]).map(x=>String(x.data||'').replace(/"\s+"/g,'').replace(/^"|"$/g,'').trim());
  const mxValues=(mx.Answer||[]).map(x=>String(x.data||''));
  return {ownership:!!domain.verification_token&&txtValues.some(x=>x===token),mx:mxValues.length>0,txt:txtValues,mxRecords:mxValues,checkedAt:new Date().toISOString()};
}

async function notify(env,userId,title,body='',type='system'){
  try{await env.DB.prepare(`INSERT INTO notifications(user_id,type,title,body) VALUES(?,?,?,?)`).bind(userId,type,title,body).run()}catch{}
}
async function setupDone(env){
  try{
    const r=await env.DB.prepare(`SELECT value_json FROM settings WHERE key='setup_completed' LIMIT 1`).first();
    if(r){try{if(JSON.parse(r.value_json)===true)return true}catch{if(r.value_json==='true')return true}}
  }catch{}
  try{
    const admin=await env.DB.prepare(`SELECT id FROM users WHERE role='super_admin' AND status='active' LIMIT 1`).first();
    return !!admin;
  }catch{return false}
}
async function markSetup(env){
  try{
    await env.DB.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('setup_completed','true',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json='true',updated_at=CURRENT_TIMESTAMP`).run();
  }catch(e){
    console.warn('SETUP_FLAG_WRITE_FAILED',{message:e?.message||String(e)});
  }
}
async function ownsMessage(env,userId,id){return env.DB.prepare(`SELECT m.* FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE m.id=? AND mb.user_id=? LIMIT 1`).bind(id,userId).first()}
async function ownsMailbox(env,userId,id){return env.DB.prepare(`SELECT * FROM mailboxes WHERE id=? AND user_id=? LIMIT 1`).bind(id,userId).first()}
// R2 objects may intentionally be shared by sender and local-recipient message rows.
// Deletion must fail closed: a reference-check failure must never destroy potentially live data.
async function deleteObjectIfUnreferenced(env,key){
  if(!key)return false;
  let reference;
  try{
    reference=await env.DB.prepare(`SELECT 1 FROM messages WHERE storage_key=? UNION ALL SELECT 1 FROM attachments WHERE storage_key=? UNION ALL SELECT 1 FROM compose_drafts WHERE storage_key=? UNION ALL SELECT 1 FROM send_operations WHERE storage_key=? UNION ALL SELECT 1 FROM users WHERE avatar_key=? OR cover_key=? LIMIT 1`).bind(key,key,key,key,key,key).first();
  }catch(e){
    // Never delete data when the reference check cannot be completed.
    console.warn('STORAGE_DELETE_SKIPPED_REFERENCE_CHECK_FAILED',{key,message:e?.message||String(e)});
    return false;
  }
  if(reference)return false;
  try{
    await env.MAIL_STORAGE.delete(key);
    return true;
  }catch(e){
    console.warn('STORAGE_DELETE_FAILED',{key,message:e?.message||String(e)});
    return false;
  }
}
async function resolveSenderIdentity(env,userId,mailboxId,address=''){
  const mb=await ownsMailbox(env,userId,mailboxId);if(!mb||!mb.is_active)return null;
  const wanted=normalizeEmail(address||mb.address);
  if(wanted===normalizeEmail(mb.address))return {...mb,sender_address:mb.address,sender_kind:'mailbox'};
  const a=await env.DB.prepare(`SELECT a.address FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id WHERE a.mailbox_id=? AND mb.user_id=? AND a.is_active=1 AND lower(a.address)=lower(?) LIMIT 1`).bind(mb.id,userId,wanted).first();
  return a?{...mb,sender_address:a.address,sender_kind:'alias'}:null;
}
async function resolveMailbox(env,address){
  const direct=await env.DB.prepare(`SELECT mb.*,u.id owner_user_id,u.display_name owner_name FROM mailboxes mb JOIN users u ON u.id=mb.user_id WHERE lower(mb.address)=lower(?) AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(address).first();
  if(direct)return direct;
  try{return await env.DB.prepare(`SELECT mb.*,u.id owner_user_id,u.display_name owner_name FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id JOIN users u ON u.id=mb.user_id WHERE lower(a.address)=lower(?) AND a.is_active=1 AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(address).first()}catch{return null}
}

async function routeApi(request,env){
  const url=new URL(request.url), path=url.pathname;

  if(path==='/api/bootstrap/status'&&request.method==='GET') return json({ok:true,setupCompleted:await setupDone(env)});
  if(path==='/api/bootstrap'&&request.method==='POST'){
    if(await setupDone(env))return forbidden('Hệ thống đã được khởi tạo.');
    const configuredSecret=String(env.SETUP_SECRET||'');
    if(configuredSecret.length<24)return json({ok:false,error:'Chưa cấu hình khóa khởi tạo đủ an toàn. Hãy cấu hình SETUP_SECRET trước khi thiết lập hệ thống.'},503);
    if(!constantTimeEqual(request.headers.get('x-setup-secret')||'',configuredSecret))return forbidden('Khóa khởi tạo không đúng.');
    const b=await bodyJson(request), name=String(b.displayName||'').trim(), email=normalizeEmail(b.email), password=String(b.password||'');
    if(name.length<2||name.length>80)return badRequest('Tên hiển thị phải từ 2 đến 80 ký tự.');
    if(!validEmail(email))return badRequest('Email không hợp lệ.');
    if(password.length<10||password.length>1024)return badRequest('Mật khẩu phải từ 10 đến 1.024 ký tự.');
    // Claim first-run setup atomically so simultaneous requests cannot create multiple roots.
    const claim=await env.DB.prepare(`UPDATE settings SET value_json='"initializing"',updated_at=CURRENT_TIMESTAMP WHERE key='setup_completed' AND value_json='false'`).run();
    if(Number(claim.meta?.changes||0)!==1)return forbidden('Hệ thống đã được khởi tạo hoặc đang được thiết lập.');

    let stage='hash-password';
    try{
      const hp=await hashPassword(password);
      stage='save-admin';
      let user=await env.DB.prepare(`SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).first();
      if(user){
        await env.DB.prepare(`UPDATE users SET display_name=?,password_salt=?,password_hash=?,password_iterations=?,role='super_admin',status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(name,hp.salt,hp.hash,hp.iterations,user.id).run();
      }else{
        await env.DB.prepare(`INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations,role,status) VALUES(?,?,?,?,?,'super_admin','active')`)
          .bind(email,name,hp.salt,hp.hash,hp.iterations).run();
        user=await env.DB.prepare(`SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).first();
      }
      if(!user?.id) throw new Error('Không thể xác định tài khoản quản trị sau khi lưu.');
      const userId=Number(user.id);
      // The setup may promote an existing account. Force a fresh login so sessions created
      // before the role/password change cannot remain valid under the new Super Admin role.
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(userId).run();

      // Các bước dưới đây là bổ sung. Nếu một bảng phụ gặp sự cố, không được làm hỏng bootstrap.
      stage='optional-profile';
      try{await env.DB.prepare(`INSERT OR IGNORE INTO user_preferences(user_id) VALUES(?)`).bind(userId).run()}catch(e){console.warn('BOOTSTRAP_OPTIONAL_PROFILE_FAILED',{message:e?.message||String(e)})}

      stage='optional-mailbox';
      let mailboxCreated=false;
      try{
        const domain=email.split('@')[1]||'';
        const managed=await env.DB.prepare(`SELECT domain FROM managed_domains WHERE lower(domain)=lower(?) AND receive_enabled=1 LIMIT 1`).bind(domain).first();
        if(managed){
          await env.DB.prepare(`INSERT OR IGNORE INTO mailboxes(user_id,address,display_name,is_primary,is_active) VALUES(?,?,?,1,1)`).bind(userId,email,name).run();
          mailboxCreated=true;
        }
      }catch(e){console.warn('BOOTSTRAP_OPTIONAL_MAILBOX_FAILED',{message:e?.message||String(e)})}

      stage='mark-setup';
      await markSetup(env);
      try{await notify(env,userId,'Chào mừng đến Sky First Mail','Tài khoản Super Admin đã được khởi tạo.','welcome')}catch{}
      try{await audit(env,userId,'bootstrap.completed','user',userId,{email})}catch{}

      stage='session';
      let sessionHeader=null;
      try{const sess=await createSession(env,userId,request);sessionHeader=sess.header}catch(e){console.warn('BOOTSTRAP_SESSION_FAILED',{message:e?.message||String(e)})}
      console.log('BOOTSTRAP_COMPLETED',{userId,email,mailboxCreated,sessionCreated:!!sessionHeader});
      return json({ok:true,setupCompleted:true,sessionCreated:!!sessionHeader},200,sessionHeader?{'set-cookie':sessionHeader}:{});
    }catch(e){
      // Release the setup claim only when no active root account was created.
      try{
        const root=await env.DB.prepare(`SELECT id FROM users WHERE role='super_admin' AND status='active' LIMIT 1`).first();
        if(!root)await env.DB.prepare(`UPDATE settings SET value_json='false',updated_at=CURRENT_TIMESTAMP WHERE key='setup_completed' AND value_json='"initializing"'`).run();
      }catch{}
      console.error('BOOTSTRAP_FAILED',{stage,email,message:e?.message||String(e),stack:e?.stack||''});
      return json({ok:false,error:'Không thể khởi tạo tài khoản quản trị. Hãy kiểm tra nhật ký máy chủ bằng mã thời điểm sự cố.'},500);
    }
  }
  if(path==='/api/login'&&request.method==='POST'){
    const b=await bodyJson(request),email=normalizeEmail(b.email),password=String(b.password||'');
    const ip=String(request.headers.get('CF-Connecting-IP')||'unknown').slice(0,128);
    const pairKey=`pair:${await digest(new TextEncoder().encode(`${ip}\u0000${email.slice(0,254)}`))}`;
    const ipKey=`ip:${await digest(new TextEncoder().encode(ip))}`;
    const now=Math.floor(Date.now()/1000),windowStart=now-15*60;
    await env.DB.prepare(`DELETE FROM login_limits WHERE window_start<=?`).bind(now-24*60*60).run();
    // Use both an account+IP bucket and an IP-wide bucket so changing email addresses
    // cannot bypass throttling. The pair bucket is stricter; the IP bucket is broader.
    for(const entry of [{key:pairKey,limit:10},{key:ipKey,limit:100}]){
      await env.DB.prepare(`INSERT INTO login_limits(key,count,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_limits.window_start<=? THEN 1 ELSE login_limits.count+1 END,window_start=CASE WHEN login_limits.window_start<=? THEN excluded.window_start ELSE login_limits.window_start END`).bind(entry.key,now,windowStart,windowStart).run();
      const attempts=await env.DB.prepare(`SELECT count,window_start FROM login_limits WHERE key=?`).bind(entry.key).first();
      if(Number(attempts?.count||0)>entry.limit&&Number(attempts?.window_start||now)>windowStart)return json({ok:false,error:'Quá nhiều lần đăng nhập. Vui lòng thử lại sau 15 phút.'},429,{'retry-after':'900'});
    }
    if(email.length>254||password.length>1024)return unauthorized('Email hoặc mật khẩu không đúng.');
    const u=await env.DB.prepare(`SELECT * FROM users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).first();
    if(!u||u.status!=='active'||!(await verifyPassword(password,u.password_salt,u.password_hash,u.password_iterations)))return unauthorized('Email hoặc mật khẩu không đúng.');
    await env.DB.prepare(`DELETE FROM login_limits WHERE key=?`).bind(pairKey).run();
    // Preserve the IP-wide counter to throttle attempts spread across many addresses.
    const s=await createSession(env,u.id,request);await env.DB.prepare(`UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?`).bind(u.id).run();
    try{await env.DB.prepare(`INSERT INTO login_history(user_id,ip,user_agent) VALUES(?,?,?)`).bind(u.id,request.headers.get('CF-Connecting-IP'),request.headers.get('User-Agent')).run()}catch{}
    await audit(env,u.id,'auth.login','user',u.id,{ip:request.headers.get('CF-Connecting-IP')}); return json({ok:true},200,{'set-cookie':s.header});
  }
  if(path==='/api/logout'&&request.method==='POST'){const h=await destroySession(request,env);return json({ok:true},200,{'set-cookie':h})}

  const user=await currentUser(request,env); if(!user)return unauthorized();

  if(path==='/api/me'&&request.method==='GET'){
    let pref={};try{pref=await env.DB.prepare(`SELECT * FROM user_preferences WHERE user_id=?`).bind(user.id).first()||{}}catch{}
    return json({ok:true,user:{id:user.id,email:user.email,displayName:user.display_name,role:user.role,status:user.status,avatarKey:user.avatar_key||null,coverKey:user.cover_key||null,profileStatus:user.profile_status||'available',allowNameChange:!!user.allow_name_change,allowAvatarChange:!!user.allow_avatar_change,allowPasswordChange:!!user.allow_password_change,allowSignatureChange:user.allow_signature_change!==0,allowThemeChange:user.allow_theme_change!==0,lastLoginAt:user.last_login_at,preferences:pref}})
  }
  if(path==='/api/mailboxes'&&request.method==='GET'){
    const r=await env.DB.prepare(`SELECT id,address,display_name,is_primary,is_active FROM mailboxes WHERE user_id=? ORDER BY is_primary DESC,id`).bind(user.id).all();return json({ok:true,mailboxes:r.results||[]})
  }

  if(path==='/api/mailbox/summary'&&request.method==='GET'){
    const rows=await env.DB.prepare(`SELECT m.folder,m.is_starred,m.is_read,count(*) n FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=? AND (m.snoozed_until IS NULL OR datetime(m.snoozed_until)<=datetime('now')) GROUP BY m.folder,m.is_starred,m.is_read`).bind(user.id).all();
    const counts={inbox:0,sent:0,drafts:0,spam:0,trash:0,archive:0,starred:0};let unread=0;
    for(const r of rows.results||[]){if(r.folder in counts)counts[r.folder]+=Number(r.n||0);if(r.is_starred&&r.folder!=='trash')counts.starred+=Number(r.n||0);if(r.folder==='inbox'&&!r.is_read)unread+=Number(r.n||0)}
    const snoozed=await env.DB.prepare(`SELECT count(*) n FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=? AND m.snoozed_until IS NOT NULL AND datetime(m.snoozed_until)>datetime('now')`).bind(user.id).first();counts.snoozed=Number(snoozed?.n||0);
    return json({ok:true,counts,unread});
  }
  if(path==='/api/messages/bulk'&&request.method==='POST'){
    const b=await bodyJson(request),ids=[...new Set((Array.isArray(b.ids)?b.ids:[]).map(Number).filter(Number.isInteger))].slice(0,200),action=String(b.action||'');
    if(!ids.length)return badRequest('Chưa chọn thư.');if(!['read','unread','star','unstar','spam','trash','inbox','archive'].includes(action))return badRequest('Thao tác không hợp lệ.');
    const qs=ids.map(()=>'?').join(',');const owned=await env.DB.prepare(`SELECT m.id FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=? AND m.id IN (${qs})`).bind(user.id,...ids).all();
    const ok=(owned.results||[]).map(x=>Number(x.id));if(!ok.length)return badRequest('Không có thư hợp lệ.');const q2=ok.map(()=>'?').join(',');
    if(action==='read'||action==='unread')await env.DB.prepare(`UPDATE messages SET is_read=? WHERE id IN (${q2})`).bind(action==='read'?1:0,...ok).run();
    else if(action==='star'||action==='unstar')await env.DB.prepare(`UPDATE messages SET is_starred=? WHERE id IN (${q2})`).bind(action==='star'?1:0,...ok).run();
    else await env.DB.prepare(`UPDATE messages SET folder=? WHERE id IN (${q2})`).bind(action,...ok).run();
    await audit(env,user.id,'mail.bulk.updated','message',null,{ids:ok,action});return json({ok:true,updated:ok.length});
  }

  if(path==='/api/messages'&&request.method==='GET'){
    const folder=String(url.searchParams.get('folder')||'inbox');
    const mailboxRaw=url.searchParams.get('mailboxId');
    const mailboxId=mailboxRaw===null||mailboxRaw===''?0:Number(mailboxRaw);
    if(!Number.isSafeInteger(mailboxId)||mailboxId<0)return badRequest('Mailbox ID không hợp lệ.');
    const q=String(url.searchParams.get('q')||'').trim().slice(0,200);
    const limitRaw=Number(url.searchParams.get('limit')||50);
    const limit=Number.isFinite(limitRaw)?Math.floor(Math.min(100,Math.max(1,limitRaw))):50;
    const beforeRaw=Number(url.searchParams.get('before')||0);
    if(!Number.isSafeInteger(beforeRaw)||beforeRaw<0)return badRequest('Con trỏ phân trang không hợp lệ.');
    let where=`mb.user_id=?`, binds=[user.id];
    if(folder==='starred')where+=` AND m.is_starred=1 AND m.folder!='trash' AND (m.snoozed_until IS NULL OR datetime(m.snoozed_until)<=datetime('now'))`;
    else if(folder==='snoozed')where+=` AND m.snoozed_until IS NOT NULL AND datetime(m.snoozed_until)>datetime('now')`;
    else{where+=` AND m.folder=?`;binds.push(FOLDERS.includes(folder)?folder:'inbox');if((FOLDERS.includes(folder)?folder:'inbox')==='inbox')where+=` AND (m.snoozed_until IS NULL OR datetime(m.snoozed_until)<=datetime('now'))`}
    if(mailboxId){where+=` AND m.mailbox_id=?`;binds.push(mailboxId)}
    if(q){where+=` AND (lower(m.sender) LIKE lower(?) OR lower(COALESCE(m.subject,'')) LIKE lower(?) OR lower(COALESCE(m.preview,'')) LIKE lower(?) OR lower(COALESCE(m.recipients_json,'')) LIKE lower(?))`;const like=`%${q}%`;binds.push(like,like,like,like)}
    const beforeId=beforeRaw;if(beforeId>0){where+=` AND m.id<?`;binds.push(beforeId)}
    const r=await env.DB.prepare(`SELECT m.id,m.mailbox_id,m.direction,m.folder,m.sender,m.recipients_json,m.subject,m.preview,m.raw_size,m.is_read,m.is_starred,m.is_important,m.snoozed_until,m.status,m.sent_at,m.received_at,m.created_at FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE ${where} ORDER BY m.id DESC LIMIT ?`).bind(...binds,limit+1).all();
    const rows=r.results||[],hasMore=rows.length>limit,messages=rows.slice(0,limit);return json({ok:true,messages,hasMore,nextCursor:hasMore?String(messages[messages.length-1]?.id||''):null})
  }
  const prooflineMatch=path.match(/^\/api\/messages\/(\d+)\/proofline$/);
  if(prooflineMatch&&request.method==='GET'){
    const row=await ownsMessage(env,user.id,Number(prooflineMatch[1]));if(!row)return notFound('Không tìm thấy thư.');
    const object=await env.MAIL_STORAGE.get(row.storage_key);if(!object)return notFound('Không thể truy xuất MIME gốc của thư.');
    const raw=new Uint8Array(await object.arrayBuffer()),currentHash=await digest(raw);let baselineHash=row.content_sha256||null,baselineAt=row.hash_recorded_at||null;
    const historicalBaseline=!!baselineHash;
    if(!baselineHash){baselineHash=currentHash;baselineAt=new Date().toISOString();await env.DB.prepare(`UPDATE messages SET content_sha256=?,hash_recorded_at=CURRENT_TIMESTAMP WHERE id=? AND (content_sha256 IS NULL OR content_sha256='')`).bind(baselineHash,row.id).run();}
    const integrityMatches=historicalBaseline?baselineHash===currentHash:null;
    const op=await env.DB.prepare(`SELECT id,status,provider_id,created_at,updated_at FROM send_operations WHERE storage_key=? LIMIT 1`).bind(row.storage_key).first().catch(()=>null);
    let events=[];if(op){const ev=await env.DB.prepare(`SELECT provider,provider_message_id,event_type,detail_json,created_at FROM delivery_events WHERE json_extract(detail_json,'$.operationId')=? ORDER BY created_at ASC`).bind(op.id).all().catch(()=>({results:[]}));events=ev.results||[];}
    const result={ok:true,version:'Sky Proofline 1.0',message:{id:row.id,direction:row.direction,messageId:row.message_id_header||null,sender:row.sender,recipients:parseJson(row.recipients_json),subject:row.subject||'',folder:row.folder,status:row.status,rawSize:raw.byteLength,createdAt:row.created_at,sentAt:row.sent_at||null,receivedAt:row.received_at||null},integrity:{algorithm:'SHA-256',baselineHash,currentHash,matches:integrityMatches,baselineSource:historicalBaseline?'captured_when_message_was_saved':'captured_on_first_proofline_review; historical integrity cannot be established',baselineRecordedAt:baselineAt},delivery:{operationId:op?.id||null,operationStatus:op?.status||row.status,providerMessageId:op?.provider_id||null,events}};
    await audit(env,user.id,integrityMatches===false?'proofline.integrity.mismatch':'proofline.reviewed','message',row.id,{matches:integrityMatches,hash:currentHash});
    return json(result);
  }

  const mm=path.match(/^\/api\/messages\/(\d+)$/);
  if(mm&&request.method==='GET'){
    const row=await ownsMessage(env,user.id,Number(mm[1]));if(!row)return notFound('Không tìm thấy thư.');const p=await parseStoredMessage(env,row.storage_key);if(!p)return notFound('Không thể tải nội dung thư. Vui lòng thử lại.');
    await env.DB.prepare(`UPDATE messages SET is_read=1 WHERE id=?`).bind(row.id).run();
    let labels=[];try{const lr=await env.DB.prepare(`SELECT l.id,l.name FROM labels l JOIN message_labels ml ON ml.label_id=l.id WHERE ml.message_id=?`).bind(row.id).all();labels=lr.results||[]}catch{}
    return json({ok:true,message:{...row,labels,parsed:{subject:p.subject||row.subject,from:p.from||null,to:p.to||[],cc:p.cc||[],date:p.date||row.received_at,text:p.text||'',html:(()=>{let h=cleanEmailHtml(p.html||'');(p.attachments||[]).forEach((a,i)=>{const cid=normalizeContentId(a.contentId||a.contentID);if(cid)h=h.replace(/cid:([^\"'\s>]+)/gi,(ref)=>normalizeContentId(ref.slice(4))===cid?`/api/messages/${row.id}/attachments/${i}?inline=1`:ref)});return h})(),attachments:(p.attachments||[]).map((a,i)=>({index:i,filename:a.filename||`attachment-${i+1}`,mimeType:a.mimeType||'application/octet-stream',size:a.content?.byteLength||0,contentId:a.contentId||a.contentID||null,inline:!!(a.contentId||a.contentID)}))}}})
  }
  if(mm&&request.method==='PATCH'){
    const id=Number(mm[1]),row=await ownsMessage(env,user.id,id);if(!row)return notFound();const b=await bodyJson(request),f=[],v=[];
    if('isRead'in b){f.push('is_read=?');v.push(boolInt(b.isRead))} if('isStarred'in b){f.push('is_starred=?');v.push(boolInt(b.isStarred))} if('isImportant'in b){f.push('is_important=?');v.push(boolInt(b.isImportant))} if('snoozedUntil'in b){if(b.snoozedUntil!==null&&(!Number.isFinite(Date.parse(b.snoozedUntil))||Date.parse(b.snoozedUntil)<=Date.now()))return badRequest('Thời gian hoãn thư phải nằm trong tương lai.');f.push('snoozed_until=?');v.push(b.snoozedUntil===null?null:new Date(b.snoozedUntil).toISOString())} if(b.folder&&FOLDERS.includes(b.folder)){f.push('folder=?');v.push(b.folder)}
    if(!f.length)return badRequest('Không có thay đổi.');await env.DB.prepare(`UPDATE messages SET ${f.join(',')} WHERE id=?`).bind(...v,id).run();return json({ok:true})
  }
  const am=path.match(/^\/api\/messages\/(\d+)\/attachments\/(\d+)$/);
  if(am&&request.method==='GET'){
    const row=await ownsMessage(env,user.id,Number(am[1]));if(!row)return notFound();const p=await parseStoredMessage(env,row.storage_key);const a=p?.attachments?.[Number(am[2])];if(!a)return notFound('Không tìm thấy tệp đính kèm.');
    return safeAttachmentResponse(a,url.searchParams.get('inline')==='1');
  }

  if(path==='/api/profile/name'&&request.method==='PATCH'){
    if(!user.allow_name_change&&!isAdmin(user))return forbidden('Tên hiển thị do quản trị viên quản lý.');const b=await bodyJson(request),name=String(b.displayName||'').trim();if(name.length<2||name.length>80)return badRequest('Tên hiển thị không hợp lệ.');await env.DB.prepare(`UPDATE users SET display_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(name,user.id).run();await audit(env,user.id,'profile.name.updated','user',user.id);return json({ok:true})
  }
  if(path==='/api/profile/status'&&request.method==='PATCH'){
    const b=await bodyJson(request),status=['available','busy','away','offline'].includes(b.status)?b.status:'available';await env.DB.prepare(`UPDATE users SET profile_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status,user.id).run();return json({ok:true})
  }
  if(path==='/api/profile/password'&&request.method==='PATCH'){
    if(!user.allow_password_change&&!isAdmin(user))return forbidden('Mật khẩu được quản lý bởi quản trị viên.');const b=await bodyJson(request),cur=String(b.currentPassword||''),next=String(b.newPassword||'');if(next.length<10||next.length>1024)return badRequest('Mật khẩu mới phải từ 10 đến 1.024 ký tự.');if(!(await verifyPassword(cur,user.password_salt,user.password_hash,user.password_iterations)))return badRequest('Mật khẩu hiện tại không đúng.');const hp=await hashPassword(next);await env.DB.prepare(`UPDATE users SET password_salt=?,password_hash=?,password_iterations=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(hp.salt,hp.hash,hp.iterations,user.id).run();await env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND id<>?`).bind(user.id,user.session_id||0).run();await notify(env,user.id,'Mật khẩu đã được thay đổi','Các phiên đăng nhập khác đã bị đăng xuất.','security');await audit(env,user.id,'security.password.changed','user',user.id);return json({ok:true})
  }
  if(path==='/api/profile/avatar'&&request.method==='POST'){
    if(!user.allow_avatar_change&&!isAdmin(user))return forbidden('Ảnh đại diện do quản trị viên quản lý.');
    const form=await request.formData(),file=form.get('avatar');
    if(!file||typeof file.arrayBuffer!=='function')return badRequest('Thiếu ảnh đại diện.');
    const type=String(file.type||'').toLowerCase(),extensions={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
    if(!extensions[type])return badRequest('Ảnh đại diện chỉ hỗ trợ PNG, JPEG, GIF hoặc WebP.');
    if(file.size<1||file.size>5*1024*1024)return badRequest('Ảnh đại diện phải lớn hơn 0 byte và tối đa 5 MB.');
    const bytes=new Uint8Array(await file.arrayBuffer());if(!isAllowedAvatarImage(type,bytes))return badRequest('Nội dung tệp không khớp định dạng ảnh đã chọn.');
    const key=`avatars/users/${user.id}/${crypto.randomUUID()}.${extensions[type]}`,old=user.avatar_key||null;
    await env.MAIL_STORAGE.put(key,bytes,{httpMetadata:{contentType:type}});
    try{await env.DB.prepare(`UPDATE users SET avatar_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(key,user.id).run()}
    catch(e){try{await env.MAIL_STORAGE.delete(key)}catch{}throw e}
    if(old&&old!==key)await deleteObjectIfUnreferenced(env,old);
    await audit(env,user.id,'profile.avatar.updated','user',user.id,{key});return json({ok:true,key})
  }
  if(path==='/api/profile/avatar'&&request.method==='DELETE'){
    if(!user.allow_avatar_change&&!isAdmin(user))return forbidden('Ảnh đại diện do quản trị viên quản lý.');
    const old=user.avatar_key||null;
    await env.DB.prepare(`UPDATE users SET avatar_key=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(user.id).run();
    if(old)await deleteObjectIfUnreferenced(env,old);
    await audit(env,user.id,'profile.avatar.deleted','user',user.id);
    return json({ok:true});
  }
  const av=path.match(/^\/api\/avatar\/(\d+)$/);
  if(av&&request.method==='GET'){
    const t=await env.DB.prepare(`SELECT avatar_key FROM users WHERE id=?`).bind(Number(av[1])).first();
    if(!t?.avatar_key)return notFound();
    const o=await env.MAIL_STORAGE.get(t.avatar_key);if(!o)return notFound();
    const originalType=String(o.httpMetadata?.contentType||'').split(';')[0].trim().toLowerCase();
    const bytes=new Uint8Array(await o.arrayBuffer());
    if(!isAllowedAvatarImage(originalType,bytes))return notFound('Ảnh đại diện cũ không an toàn hoặc không hợp lệ; hãy tải lại ảnh PNG, JPEG, GIF hoặc WebP.');
    return new Response(bytes,{headers:{'content-type':originalType,'content-disposition':'inline','cache-control':'private,max-age=3600','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox; object-src 'none'; base-uri 'none'",'cross-origin-resource-policy':'same-origin'}});
  }

  if(path==='/api/preferences'&&request.method==='PATCH'){
    if(user.allow_theme_change===0)return forbidden('Giao diện được quản lý bởi quản trị viên.');const b=await bodyJson(request),theme=['light','dark','system','sky'].includes(b.theme)?b.theme:'system',density=['comfortable','compact'].includes(b.density)?b.density:'comfortable',pane=['right','none'].includes(b.readingPane)?b.readingPane:'right';await env.DB.prepare(`INSERT INTO user_preferences(user_id,theme,density,reading_pane,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,density=excluded.density,reading_pane=excluded.reading_pane,updated_at=CURRENT_TIMESTAMP`).bind(user.id,theme,density,pane).run();return json({ok:true})
  }

  if(path==='/api/directory'&&request.method==='GET'){
    if(!isAdmin(user))return forbidden('Bạn không có quyền truy cập Danh bạ.');
    const q=String(url.searchParams.get('q')||'').trim().slice(0,120),like=`%${q}%`;const r=await env.DB.prepare(`SELECT id,email,display_name,role,avatar_key,profile_status FROM users WHERE status='active' AND (?='' OR lower(email) LIKE lower(?) OR lower(display_name) LIKE lower(?)) ORDER BY display_name LIMIT 100`).bind(q,like,like).all();return json({ok:true,people:r.results||[]})
  }
  if(path==='/api/contacts'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM contacts WHERE owner_user_id=? ORDER BY display_name,email`).bind(user.id).all();return json({ok:true,contacts:r.results||[]})}
  if(path==='/api/contacts'&&request.method==='POST'){
    const b=await bodyJson(request),email=normalizeEmail(b.email),name=String(b.displayName||'').trim(),notes=String(b.notes||'').trim();
    if(!validEmail(email))return badRequest('Email không hợp lệ.');
    if(name.length>120||notes.length>2000)return badRequest('Tên liên hệ tối đa 120 ký tự; ghi chú tối đa 2.000 ký tự.');
    await env.DB.prepare(`INSERT INTO contacts(owner_user_id,email,display_name,notes) VALUES(?,?,?,?) ON CONFLICT(owner_user_id,email) DO UPDATE SET display_name=excluded.display_name,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).bind(user.id,email,name,notes).run();return json({ok:true})
  }

  if(path==='/api/notifications'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).bind(user.id).all();return json({ok:true,notifications:r.results||[]})}
  const nm=path.match(/^\/api\/notifications\/(\d+)\/read$/);if(nm&&request.method==='POST'){await env.DB.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?`).bind(Number(nm[1]),user.id).run();return json({ok:true})}

  if(path==='/api/sessions'&&request.method==='GET'){let r;try{r=await env.DB.prepare(`SELECT id,ip,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=? ORDER BY COALESCE(last_seen_at,created_at) DESC`).bind(user.id).all()}catch{r=await env.DB.prepare(`SELECT id,created_at,expires_at FROM sessions WHERE user_id=? ORDER BY created_at DESC`).bind(user.id).all()}return json({ok:true,sessions:r.results||[],currentSessionId:user.session_id})}
  const sm=path.match(/^\/api\/sessions\/(\d+)$/);if(sm&&request.method==='DELETE'){const id=Number(sm[1]);if(id===Number(user.session_id))return badRequest('Không thể thu hồi phiên đang dùng. Hãy đăng xuất thay thế.');await env.DB.prepare(`DELETE FROM sessions WHERE id=? AND user_id=?`).bind(id,user.id).run();return json({ok:true})}

  if(path==='/api/sender-identities'&&request.method==='GET'){
    const mb=await env.DB.prepare(`SELECT id,address,display_name,is_primary,is_active FROM mailboxes WHERE user_id=? AND is_active=1 ORDER BY is_primary DESC,id`).bind(user.id).all();
    const al=await env.DB.prepare(`SELECT a.id,a.mailbox_id,a.address,mb.display_name FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id WHERE mb.user_id=? AND a.is_active=1 AND mb.is_active=1 ORDER BY a.address`).bind(user.id).all();
    return json({ok:true,mailboxes:mb.results||[],aliases:al.results||[]});
  }
  if(path==='/api/templates'&&request.method==='GET'){
    const r=await env.DB.prepare(`SELECT id,name,subject,body_html,body_text,category,created_at,updated_at FROM mail_templates WHERE user_id=? ORDER BY updated_at DESC LIMIT 200`).bind(user.id).all();return json({ok:true,templates:r.results||[]});
  }
  if(path==='/api/templates'&&request.method==='POST'){
    const b=await bodyJson(request),name=String(b.name||'').trim().slice(0,100),subject=String(b.subject||'').slice(0,998),html=cleanEmailHtml(String(b.bodyHtml||'')).slice(0,250000),text=String(b.bodyText||'').slice(0,250000),category=String(b.category||'personal').trim().slice(0,40)||'personal';if(!name)return badRequest('Thiếu tên mẫu email.');const r=await env.DB.prepare(`INSERT INTO mail_templates(user_id,name,subject,body_html,body_text,category) VALUES(?,?,?,?,?,?)`).bind(user.id,name,subject,html,text,category).run();await audit(env,user.id,'template.created','template',r.meta.last_row_id,{name});return json({ok:true,id:r.meta.last_row_id});
  }
  const tm=path.match(/^\/api\/templates\/(\d+)$/);if(tm&&request.method==='DELETE'){const id=Number(tm[1]);await env.DB.prepare(`DELETE FROM mail_templates WHERE id=? AND user_id=?`).bind(id,user.id).run();await audit(env,user.id,'template.deleted','template',id);return json({ok:true})}

  if(path==='/api/signatures'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM signatures WHERE user_id=? ORDER BY is_default DESC,id`).bind(user.id).all();return json({ok:true,signatures:r.results||[]})}
  if(path==='/api/signatures'&&request.method==='POST'){if(user.allow_signature_change===0)return forbidden('Chữ ký do quản trị viên quản lý.');const b=await bodyJson(request),name=String(b.name||'Chữ ký').trim().slice(0,80),html=cleanEmailHtml(String(b.contentHtml||'')).slice(0,20000),mailboxId=b.mailboxId?Number(b.mailboxId):null;if(mailboxId&&!await ownsMailbox(env,user.id,mailboxId))return forbidden();if(b.isDefault)await env.DB.prepare(`UPDATE signatures SET is_default=0 WHERE user_id=?`).bind(user.id).run();const r=await env.DB.prepare(`INSERT INTO signatures(user_id,mailbox_id,name,content_html,is_default) VALUES(?,?,?,?,?)`).bind(user.id,mailboxId,name,html,boolInt(b.isDefault)).run();return json({ok:true,id:r.meta.last_row_id})}

  if(path==='/api/labels'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM labels WHERE user_id=? ORDER BY name`).bind(user.id).all();return json({ok:true,labels:r.results||[]})}
  if(path==='/api/labels'&&request.method==='POST'){const b=await bodyJson(request),name=String(b.name||'').trim().slice(0,50);if(!name)return badRequest('Thiếu tên nhãn.');try{const r=await env.DB.prepare(`INSERT INTO labels(user_id,name) VALUES(?,?)`).bind(user.id,name).run();return json({ok:true,id:r.meta.last_row_id})}catch{return badRequest('Nhãn đã tồn tại.')}}
  const mlm=path.match(/^\/api\/messages\/(\d+)\/labels\/(\d+)$/);if(mlm){const m=await ownsMessage(env,user.id,Number(mlm[1]));if(!m)return notFound();const l=await env.DB.prepare(`SELECT id FROM labels WHERE id=? AND user_id=?`).bind(Number(mlm[2]),user.id).first();if(!l)return notFound();if(request.method==='POST'){await env.DB.prepare(`INSERT OR IGNORE INTO message_labels(message_id,label_id) VALUES(?,?)`).bind(m.id,l.id).run();return json({ok:true})}if(request.method==='DELETE'){await env.DB.prepare(`DELETE FROM message_labels WHERE message_id=? AND label_id=?`).bind(m.id,l.id).run();return json({ok:true})}}

  if(path==='/api/rules'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM mail_rules WHERE user_id=? ORDER BY id DESC`).bind(user.id).all();return json({ok:true,rules:r.results||[]})}
  if(path==='/api/rules'&&request.method==='POST'){
    const b=await bodyJson(request),name=String(b.name||'Quy tắc').trim().slice(0,80)||'Quy tắc';
    const mailboxId=b.mailboxId?Number(b.mailboxId):null;
    if(mailboxId!==null&&(!Number.isSafeInteger(mailboxId)||mailboxId<1||!await ownsMailbox(env,user.id,mailboxId)))return badRequest('Mailbox trong quy tắc không hợp lệ.');
    const folder=['inbox','spam','trash'].includes(b.actionFolder)?b.actionFolder:null;
    const senderContains=String(b.senderContains||'').trim().slice(0,200)||null,subjectContains=String(b.subjectContains||'').trim().slice(0,200)||null;
    const r=await env.DB.prepare(`INSERT INTO mail_rules(user_id,mailbox_id,name,sender_contains,subject_contains,action_folder,action_star,is_active) VALUES(?,?,?,?,?,?,?,1)`).bind(user.id,mailboxId,name,senderContains,subjectContains,folder,boolInt(b.actionStar)).run();
    return json({ok:true,id:r.meta.last_row_id});
  }

  if(path==='/api/compose'&&request.method==='POST'){
    return reliableCompose(request,env,user,{resolveSenderIdentity,resolveMailbox,ownsMessage,notify,audit,sendWithResend:async(_env,payload)=>{
      const domainName=(payload.fromAddress.split('@')[1]||'').toLowerCase();
      const domain=await env.DB.prepare(`SELECT * FROM managed_domains WHERE lower(domain)=lower(?) LIMIT 1`).bind(domainName).first();
      if(!domain?.send_enabled||domain.status==='disabled')throw Object.assign(new Error('Tên miền gửi chưa được bật.'),{definitive:true});
      return sendExternal(env,domain,payload);
    }});
  }


  // V4 reliability + productivity endpoints
  if(path==='/api/health'&&request.method==='GET'){
    return json({ok:true,service:'Trung tâm Thư điện tử Sky First',status:'ready',time:new Date().toISOString()});
  }
  if(path==='/api/mailbox/usage'&&request.method==='GET'){
    const r=await env.DB.prepare(`SELECT count(*) message_count,COALESCE(sum(m.raw_size),0) message_bytes FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=?`).bind(user.id).first();
    return json({ok:true,messageCount:Number(r?.message_count||0),messageBytes:Number(r?.message_bytes||0)});
  }
  if(path==='/api/messages/mark-all-read'&&request.method==='POST'){
    const b=await bodyJson(request),folder=FOLDERS.includes(b.folder)?b.folder:'inbox';
    await env.DB.prepare(`UPDATE messages SET is_read=1 WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?) AND folder=?`).bind(user.id,folder).run();
    return json({ok:true});
  }
  if(path==='/api/sessions/others'&&request.method==='DELETE'){
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND id<>?`).bind(user.id,user.session_id).run();
    await audit(env,user.id,'security.sessions.revoked','user',user.id,{except:user.session_id});
    return json({ok:true});
  }
  const cm=path.match(/^\/api\/contacts\/(\d+)$/);
  if(cm&&request.method==='DELETE'){
    await env.DB.prepare(`DELETE FROM contacts WHERE id=? AND owner_user_id=?`).bind(Number(cm[1]),user.id).run();
    return json({ok:true});
  }
  const sigm=path.match(/^\/api\/signatures\/(\d+)$/);
  if(sigm&&request.method==='DELETE'){
    if(user.allow_signature_change===0)return forbidden('Chữ ký do quản trị viên quản lý.');
    await env.DB.prepare(`DELETE FROM signatures WHERE id=? AND user_id=?`).bind(Number(sigm[1]),user.id).run();
    return json({ok:true});
  }
  const rulem=path.match(/^\/api\/rules\/(\d+)$/);
  if(rulem&&request.method==='DELETE'){
    await env.DB.prepare(`DELETE FROM mail_rules WHERE id=? AND user_id=?`).bind(Number(rulem[1]),user.id).run();
    return json({ok:true});
  }
  if(rulem&&request.method==='PATCH'){
    const b=await bodyJson(request);if(!('isActive' in b))return badRequest('Không có thay đổi.');
    await env.DB.prepare(`UPDATE mail_rules SET is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`).bind(boolInt(b.isActive),Number(rulem[1]),user.id).run();
    return json({ok:true});
  }
  if(path==='/api/drafts'&&request.method==='GET'){
    const r=await env.DB.prepare(`SELECT id,mailbox_id,to_json,cc_json,bcc_json,subject,body_text,body_html,sender_address,reply_to_message_id,attachment_names_json,created_at,updated_at FROM compose_drafts WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`).bind(user.id).all();
    return json({ok:true,drafts:r.results||[]});
  }
  if(path==='/api/drafts'&&request.method==='POST'){
    const form=await request.formData();
    const id=Number(form.get('draftId')||0),mailboxId=Number(form.get('mailboxId')||0),mb=await ownsMailbox(env,user.id,mailboxId);
    if(!mb)return badRequest('Mailbox không hợp lệ.');
    const to=String(form.get('to')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),cc=String(form.get('cc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),bcc=String(form.get('bcc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean);
    const subject=String(form.get('subject')||'').replace(/[\r\n]/g,' ').slice(0,998),text=String(form.get('text')||'').slice(0,500000),html=cleanEmailHtml(String(form.get('html')||'')).slice(0,500000),senderAddress=normalizeEmail(form.get('senderAddress')||mb.address),replyToMessageId=Number(form.get('replyToMessageId')||0)||null;
    if(replyToMessageId&&!await ownsMessage(env,user.id,replyToMessageId))return notFound('Không tìm thấy thư gốc để trả lời.');
    const attachments=form.getAll('attachments').filter(x=>x&&typeof x.arrayBuffer==='function'),inlineAttachments=form.getAll('inlineAttachments').filter(x=>x&&typeof x.arrayBuffer==='function');
    let total=0;for(const a of [...attachments,...inlineAttachments])total+=a.size||0;
    if(total>12*1024*1024)return badRequest('Tổng tệp đính kèm và ảnh nội tuyến tối đa 12 MB.');
    if(attachments.length+inlineAttachments.length>100)return badRequest('Mỗi bản nháp tối đa 100 tệp đính kèm.');
    let inlineCidMap=[];try{inlineCidMap=JSON.parse(String(form.get('inlineCidMap')||'[]'))}catch{}
    if(!Array.isArray(inlineCidMap)||inlineCidMap.length!==inlineAttachments.length||inlineCidMap.some((x,i)=>!x||String(x.name||'')!==String(inlineAttachments[i]?.name||'')||!/^[-a-zA-Z0-9_.@]{1,127}$/.test(x.cid||'')))return badRequest('Danh sách ảnh nội tuyến không hợp lệ.');
    if(new Set(inlineCidMap.map(x=>x.cid)).size!==inlineCidMap.length)return badRequest('Mỗi ảnh nội tuyến phải có một mã CID riêng.');
    if(inlineAttachments.some(a=>!/^image\/(png|jpeg|gif|webp)$/.test(String(a.type||'').split(';')[0].toLowerCase())))return badRequest('Ảnh nội tuyến phải là PNG, JPEG, GIF hoặc WebP.');
    for(const a of inlineAttachments){if(!isAllowedAvatarImage(a.type,new Uint8Array(await a.arrayBuffer())))return badRequest('Nội dung ảnh nội tuyến không khớp với định dạng ảnh khai báo.');}
    const replaceAttachments=form.get('replaceAttachments')==='1';
    const names=[...attachments,...inlineAttachments].map(a=>String(a.name||'attachment').slice(0,180));
    // Resolve an existing draft before writing to object storage, so a stale/malicious ID cannot leak orphan blobs.
    const old=id?await env.DB.prepare(`SELECT storage_key,attachment_names_json FROM compose_drafts WHERE id=? AND user_id=?`).bind(id,user.id).first():null;
    if(id&&!old)return notFound('Không tìm thấy bản nháp.');
    let storageKey=null;
    try{
      if(names.length){
        const raw=await buildMime({from:senderAddress||mb.address,to:to.length?to:[mb.address],cc,bcc,subject,text,html,attachments,inlineAttachments,inlineCidMap});
        storageKey=`drafts/${user.id}/${Date.now()}-${crypto.randomUUID()}.eml`;
        await env.MAIL_STORAGE.put(storageKey,raw,{httpMetadata:{contentType:'message/rfc822'}});
      }
      if(id){
        const storageExpr=replaceAttachments?'?':'COALESCE(?,storage_key)';
        const namesExpr=(replaceAttachments||storageKey)?'?':'attachment_names_json';
        const statement=`UPDATE compose_drafts SET mailbox_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,body_text=?,body_html=?,sender_address=?,reply_to_message_id=?,storage_key=${storageExpr},attachment_names_json=${namesExpr},updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`;
        const values=[mailboxId,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,text,html,senderAddress,replyToMessageId,storageKey];
        if(namesExpr==='?')values.push(JSON.stringify(names));
        values.push(id,user.id);
        await env.DB.prepare(statement).bind(...values).run();
        if((replaceAttachments||storageKey)&&old.storage_key&&old.storage_key!==storageKey)await deleteObjectIfUnreferenced(env,old.storage_key);
        return json({ok:true,id});
      }
      const r=await env.DB.prepare(`INSERT INTO compose_drafts(user_id,mailbox_id,to_json,cc_json,bcc_json,subject,body_text,body_html,sender_address,reply_to_message_id,storage_key,attachment_names_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(user.id,mailboxId,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,text,html,senderAddress,replyToMessageId,storageKey,JSON.stringify(names)).run();
      return json({ok:true,id:r.meta.last_row_id});
    }catch(e){
      if(storageKey)await deleteObjectIfUnreferenced(env,storageKey);
      throw e;
    }
  }

  const dm=path.match(/^\/api\/drafts\/(\d+)$/);
  if(dm&&request.method==='GET'){
    const d=await env.DB.prepare(`SELECT * FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).first();if(!d)return notFound('Không tìm thấy bản nháp.');let attachments=[];if(d.storage_key){const parsed=await parseStoredMessage(env,d.storage_key);attachments=(parsed?.attachments||[]).map((a,index)=>({index,filename:a.filename||`attachment-${index+1}`,mimeType:a.mimeType||'application/octet-stream',size:a.content?.byteLength||0,contentId:a.contentId||a.contentID||null,inline:!!(a.contentId||a.contentID)}))}return json({ok:true,draft:d,attachments});
  }
  const draftAttachment=path.match(/^\/api\/drafts\/(\d+)\/attachments\/(\d+)$/);
  if(draftAttachment&&request.method==='GET'){
    const d=await env.DB.prepare(`SELECT storage_key FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(draftAttachment[1]),user.id).first();if(!d?.storage_key)return notFound('Không tìm thấy tệp trong bản nháp.');const parsed=await parseStoredMessage(env,d.storage_key),a=parsed?.attachments?.[Number(draftAttachment[2])];if(!a)return notFound('Không tìm thấy tệp trong bản nháp.');return safeAttachmentResponse(a,false);
  }
  if(dm&&request.method==='DELETE'){
    const d=await env.DB.prepare(`SELECT storage_key FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).first();await env.DB.prepare(`DELETE FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).run();if(d?.storage_key)await deleteObjectIfUnreferenced(env,d.storage_key);return json({ok:true});
  }
  if(mm&&request.method==='DELETE'){
    const id=Number(mm[1]),row=await ownsMessage(env,user.id,id);if(!row)return notFound();if(row.folder!=='trash')return badRequest('Chỉ có thể xóa vĩnh viễn thư đang ở Thùng rác.');
    await env.DB.prepare(`DELETE FROM messages WHERE id=?`).bind(id).run();
    await deleteObjectIfUnreferenced(env,row.storage_key);
    await audit(env,user.id,'mail.deleted.permanently','message',id);return json({ok:true});
  }

  if(path.startsWith('/api/admin/')){
    if(!isAdmin(user))return forbidden();
    if(path==='/api/admin/dashboard'&&request.method==='GET'){
      const [u,m,mb,unread]=await env.DB.batch([env.DB.prepare(`SELECT count(*) n FROM users`),env.DB.prepare(`SELECT count(*) n,COALESCE(sum(raw_size),0) bytes FROM messages`),env.DB.prepare(`SELECT count(*) n FROM mailboxes WHERE is_active=1`),env.DB.prepare(`SELECT count(*) n FROM messages WHERE is_read=0 AND folder='inbox'`)]);return json({ok:true,stats:{users:u.results?.[0]?.n||0,messages:m.results?.[0]?.n||0,bytes:m.results?.[0]?.bytes||0,activeMailboxes:mb.results?.[0]?.n||0,unread:unread.results?.[0]?.n||0}})
    }
    if(path==='/api/admin/system'&&request.method==='GET'){
      let pageCount=null,pageSize=null;
      try{pageCount=(await env.DB.prepare('PRAGMA page_count').first())?.page_count??null;pageSize=(await env.DB.prepare('PRAGMA page_size').first())?.page_size??null}catch{}
      const m=await env.DB.prepare(`SELECT count(*) message_count,COALESCE(sum(raw_size),0) message_bytes FROM messages`).first();
      const u=await env.DB.prepare(`SELECT count(*) user_count FROM users`).first();
      const d=await env.DB.prepare(`SELECT COUNT(*) enabled_receiving FROM managed_domains WHERE receive_enabled=1 AND status<>'disabled'`).first();
      const transportReady=await env.DB.prepare(`SELECT COUNT(*) ready_domains FROM managed_domains WHERE send_enabled=1 AND status='verified' AND ((transport='resend' AND ?=1) OR (transport='gateway' AND ?=1 AND ?=1))`).bind(env.RESEND_API_KEY?1:0,env.MTA_GATEWAY_URL?1:0,env.MTA_GATEWAY_TOKEN?1:0).first();
      // These are configuration indicators only; they do not prove live MX/Email Routing/provider health.
      return json({ok:true,storage:{messageBytes:Number(m?.message_bytes||0),messageCount:Number(m?.message_count||0)},accounts:{users:Number(u?.user_count||0)},services:{sending:Number(transportReady?.ready_domains||0)>0,receivingConfigured:Number(d?.enabled_receiving||0)>0,receivingEnabledDomains:Number(d?.enabled_receiving||0)}})
    }
    if(path==='/api/admin/users'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.role,u.status,u.avatar_key,u.allow_name_change,u.allow_avatar_change,u.allow_password_change,u.allow_signature_change,u.allow_theme_change,u.last_login_at,(SELECT count(*) FROM mailboxes mb WHERE mb.user_id=u.id) mailbox_count,(SELECT id FROM mailboxes mb2 WHERE mb2.user_id=u.id ORDER BY is_primary DESC,id LIMIT 1) primary_mailbox_id FROM users u ORDER BY u.created_at DESC`).all();return json({ok:true,users:r.results||[]})}
    if(path==='/api/admin/users'&&request.method==='POST'){
      const b=await bodyJson(request),name=String(b.displayName||'').trim(),email=normalizeEmail(b.email),password=String(b.password||'');
      if(b.role!==undefined&&!ROLES.includes(b.role))return badRequest('Vai trò không hợp lệ.');
      if(b.role&&b.role!=='user'&&user.role!=='super_admin')return forbidden('Chỉ Siêu quản trị viên được cấp quyền quản trị.');
      if(name.length<2||name.length>80||!validEmail(email)||password.length<10||password.length>1024)return badRequest('Kiểm tra lại tên (2–80 ký tự), email và mật khẩu (10–1.024 ký tự).');
      const emailDomain=email.split('@')[1]||'';
      const allowedDomain=await env.DB.prepare(`SELECT id FROM managed_domains WHERE lower(domain)=lower(?) LIMIT 1`).bind(emailDomain).first();
      if(!allowedDomain)return badRequest('Tên miền email chưa được thêm trong Quản trị > Tên miền.');
      const hp=await hashPassword(password);
      try{
        // Insert user, mailbox and preferences atomically to avoid a half-created account.
        const results=await env.DB.batch([
          env.DB.prepare(`INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations,role,status,allow_name_change,allow_avatar_change,allow_password_change,allow_signature_change,allow_theme_change) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(email,name,hp.salt,hp.hash,hp.iterations,safeRole(b.role),b.status==='disabled'?'disabled':'active',boolInt(b.allowNameChange),boolInt(b.allowAvatarChange),boolInt(b.allowPasswordChange??true),boolInt(b.allowSignatureChange??true),boolInt(b.allowThemeChange??true)),
          env.DB.prepare(`INSERT INTO mailboxes(user_id,address,display_name,is_primary,is_active) SELECT id,?,?,1,? FROM users WHERE lower(email)=lower(?)`).bind(email,name,b.mailboxActive===false?0:1,email),
          env.DB.prepare(`INSERT OR IGNORE INTO user_preferences(user_id) SELECT id FROM users WHERE lower(email)=lower(?)`).bind(email)
        ]);
        const id=Number(results?.[0]?.meta?.last_row_id||0);
        if(!id)throw new Error('Không xác định được ID tài khoản vừa tạo.');
        // Once the account/mailbox transaction has committed, best-effort notifications or audit must not report a false create failure.
        try{await notify(env,id,'Tài khoản Sky First đã được tạo',`Địa chỉ: ${email}`,'account')}catch(error){console.error('ADMIN_USER_CREATE_NOTIFY_FAILED',{id,message:error?.message||String(error)})}
        try{await audit(env,user.id,'admin.user.created','user',id,{email})}catch(error){console.error('ADMIN_USER_CREATE_AUDIT_FAILED',{id,actorUserId:user.id,message:error?.message||String(error)})}
        return json({ok:true,id});
      }catch(e){if(String(e).toLowerCase().includes('unique'))return badRequest('Email hoặc địa chỉ mailbox đã tồn tại.');throw e}
    }
    const aum=path.match(/^\/api\/admin\/users\/(\d+)$/);if(aum&&request.method==='PATCH'){
      const id=Number(aum[1]),target=await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first();if(!target)return notFound();if(target.role!=='user'&&user.role!=='super_admin')return forbidden('Chỉ Siêu quản trị viên được sửa tài khoản quản trị.');const b=await bodyJson(request),f=[],v=[];
      if(typeof b.displayName==='string'){const n=b.displayName.trim();if(n.length<2||n.length>80)return badRequest('Tên phải từ 2 đến 80 ký tự.');f.push('display_name=?');v.push(n)}
      if(b.role!==undefined){if(!ROLES.includes(b.role))return badRequest('Vai trò không hợp lệ.');if(user.role!=='super_admin'&&b.role!==target.role&&b.role!=='user')return forbidden('Chỉ Siêu quản trị viên được cấp quyền quản trị.');f.push('role=?');v.push(b.role)}
      if(['active','disabled'].includes(b.status)){f.push('status=?');v.push(b.status)}
      const nextRole=b.role!==undefined&&ROLES.includes(b.role)?b.role:target.role,nextStatus=['active','disabled'].includes(b.status)?b.status:target.status;
      const currentlyRoot=target.role==='super_admin'&&target.status==='active',willBeRoot=nextRole==='super_admin'&&nextStatus==='active';
      for(const [k,c] of [['allowNameChange','allow_name_change'],['allowAvatarChange','allow_avatar_change'],['allowPasswordChange','allow_password_change'],['allowSignatureChange','allow_signature_change'],['allowThemeChange','allow_theme_change']])if(k in b){f.push(`${c}=?`);v.push(boolInt(b[k]))}
      if(!f.length)return badRequest('Không có thay đổi.');
      if(currentlyRoot&&!willBeRoot){
        // Count protection must live inside UPDATE, not in a separate SELECT: concurrent edits must not demote the last root.
        const update=await env.DB.prepare(`UPDATE users SET ${[...f,'updated_at=CURRENT_TIMESTAMP'].join(',')} WHERE id=? AND role='super_admin' AND status='active' AND (SELECT count(*) FROM users WHERE role='super_admin' AND status='active')>1`).bind(...v,id).run();
        if(Number(update.meta?.changes||0)!==1)return badRequest('Không thể thay đổi vai trò hoặc trạng thái Siêu quản trị viên cuối cùng đang hoạt động.');
        try{await notify(env,id,'Quyền tài khoản đã được cập nhật','Quản trị viên vừa thay đổi cài đặt tài khoản của bạn.','account')}catch(error){console.error('ADMIN_USER_UPDATE_NOTIFY_FAILED',{id,message:error?.message||String(error)})}try{await audit(env,user.id,'admin.user.updated','user',id,b)}catch(error){console.error('ADMIN_USER_UPDATE_AUDIT_FAILED',{id,actorUserId:user.id,message:error?.message||String(error)})}return json({ok:true});
      }
      f.push('updated_at=CURRENT_TIMESTAMP');const update=await env.DB.prepare(`UPDATE users SET ${f.join(',')} WHERE id=?`).bind(...v,id).run();if(Number(update.meta?.changes||0)!==1)return notFound('Tài khoản không còn tồn tại hoặc đã thay đổi.');try{await notify(env,id,'Quyền tài khoản đã được cập nhật','Quản trị viên vừa thay đổi cài đặt tài khoản của bạn.','account')}catch(error){console.error('ADMIN_USER_UPDATE_NOTIFY_FAILED',{id,message:error?.message||String(error)})}try{await audit(env,user.id,'admin.user.updated','user',id,b)}catch(error){console.error('ADMIN_USER_UPDATE_AUDIT_FAILED',{id,actorUserId:user.id,message:error?.message||String(error)})}return json({ok:true})
    }
    if(aum&&request.method==='DELETE'){
      const id=Number(aum[1]);
      if(id===Number(user.id))return badRequest('Không thể xóa chính tài khoản đang đăng nhập.');
      const target=await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first();
      if(!target)return notFound('Không tìm thấy tài khoản.');
      if(target.role!=='user'&&user.role!=='super_admin')return forbidden('Chỉ Siêu quản trị viên được xóa tài khoản quản trị.');
      const b=await bodyJson(request);if(b.confirm!==true && normalizeEmail(b.confirmEmail)!==normalizeEmail(target.email))return badRequest('Yêu cầu xác nhận xóa không hợp lệ. Hãy xác nhận trong giao diện quản trị rồi thử lại.');
      const canDeleteSql=`(role<>'super_admin' OR status<>'active' OR (SELECT count(*) FROM users WHERE role='super_admin' AND status='active')>1)`;
      const objects=[];let deleteStage='schema-inventory',results;
      try{
        // Inventory storage objects independently. Missing optional columns on an older
        // production schema must never prevent the database account deletion itself.
        const quoteIdent=value=>`"${String(value).replaceAll('"','""')}"`;
        const tableRows=await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
        const tableNames=(tableRows.results||[]).map(r=>String(r.name||'')).filter(Boolean);
        const tableSet=new Set(tableNames),columns=new Map(),foreignKeys=new Map();
        for(const table of tableNames){
          try{
            const meta=await env.DB.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
            columns.set(table,new Set((meta.results||[]).map(c=>String(c.name||''))));
          }catch(error){
            columns.set(table,new Set());
            console.warn('ADMIN_DELETE_TABLE_INFO_UNAVAILABLE',{table,message:error?.message||String(error)});
          }
          try{
            const meta=await env.DB.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all();
            const grouped=new Map();
            for(const fk of meta.results||[]){
              const key=String(fk.id);
              if(!grouped.has(key))grouped.set(key,[]);
              grouped.get(key).push({seq:Number(fk.seq||0),parent:String(fk.table||''),from:String(fk.from||''),to:String(fk.to||''),onDelete:String(fk.on_delete||'NO ACTION').toUpperCase()});
            }
            foreignKeys.set(table,[...grouped.values()].map(group=>group.sort((a,b)=>a.seq-b.seq)));
          }catch(error){
            foreignKeys.set(table,[]);
            console.warn('ADMIN_DELETE_FK_INSPECTION_UNAVAILABLE',{table,message:error?.message||String(error)});
          }
        }
        const hasColumn=(table,column)=>!!columns.get(table)?.has(column);
        const addStorageQuery=async(sql,binds=[])=>{
          try{
            const r=await env.DB.prepare(sql).bind(...binds).all();
            for(const row of r.results||[])if(row.storage_key)objects.push(String(row.storage_key));
          }catch(error){
            // Storage collection is best-effort. Database deletion has priority;
            // post-delete object cleanup still checks whether each object is referenced.
            console.warn('ADMIN_DELETE_STORAGE_INVENTORY_SKIPPED',{message:error?.message||String(error)});
          }
        };
        if(hasColumn('messages','storage_key')&&hasColumn('messages','mailbox_id')&&hasColumn('mailboxes','user_id')&&hasColumn('mailboxes','id'))
          await addStorageQuery(`SELECT storage_key FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?) AND storage_key IS NOT NULL`,[id]);
        if(hasColumn('attachments','storage_key')&&hasColumn('attachments','message_id')&&hasColumn('messages','id')&&hasColumn('messages','mailbox_id')&&hasColumn('mailboxes','user_id'))
          await addStorageQuery(`SELECT a.storage_key FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?) AND a.storage_key IS NOT NULL`,[id]);
        if(hasColumn('users','avatar_key'))await addStorageQuery(`SELECT avatar_key AS storage_key FROM users WHERE id=? AND avatar_key IS NOT NULL`,[id]);
        if(hasColumn('users','cover_key'))await addStorageQuery(`SELECT cover_key AS storage_key FROM users WHERE id=? AND cover_key IS NOT NULL`,[id]);
        if(hasColumn('compose_drafts','storage_key')&&hasColumn('compose_drafts','user_id'))await addStorageQuery(`SELECT storage_key FROM compose_drafts WHERE user_id=? AND storage_key IS NOT NULL`,[id]);
        if(hasColumn('send_operations','storage_key')&&hasColumn('send_operations','user_id'))await addStorageQuery(`SELECT storage_key FROM send_operations WHERE user_id=? AND storage_key IS NOT NULL`,[id]);

        deleteStage='dependency-plan';
        // Build a deletion closure from the live D1 foreign-key metadata rather than
        // assuming every deployed database exactly matches the newest migration files.
        // CASCADE and NO ACTION/RESTRICT dependents are explicitly removed child-first.
        // messages are explicitly owned by the mailbox even though their legacy FK is SET NULL.
        const rootCondition=`${quoteIdent('users')}.${quoteIdent('id')}=?`;
        const conditionByTable=new Map([['users',rootCondition]]);
        const edges=[];
        const queue=['users'];
        const queued=new Set(queue);
        const explicitChild=(child,parent,action)=>child==='messages'&&parent==='mailboxes'&&action==='SET NULL';
        while(queue.length){
          const parent=queue.shift();
          for(const child of tableNames){
            if(child==='users'&&parent==='users')continue;
            for(const group of (foreignKeys.get(child)||[])){
              if(!group.length||group[0].parent!==parent)continue;
              const action=group[0].onDelete||'NO ACTION';
              if(!['CASCADE','NO ACTION','RESTRICT'].includes(action)&&!explicitChild(child,parent,action))continue;
              // Only single-column FK edges are expected by this application. For a
              // composite FK, build one correlated EXISTS covering every column.
              const join=group.map(fk=>`${quoteIdent(child)}.${quoteIdent(fk.from)} = ${quoteIdent(parent)}.${quoteIdent(fk.to||'id')}`).join(' AND ');
              const childCondition=`EXISTS (SELECT 1 FROM ${quoteIdent(parent)} WHERE ${join} AND (${conditionByTable.get(parent)||rootCondition}))`;
              if(!conditionByTable.has(child)){
                conditionByTable.set(child,childCondition);
                if(!queued.has(child)){queue.push(child);queued.add(child)}
              }
              edges.push({parent,child});
            }
          }
        }
        // Fallback for a fresh/older database where FK introspection is unavailable or
        // some legacy tables were created without constraints. These are known owned rows.
        const directFallback={
          send_operations:['user_id'],login_history:['user_id'],mail_templates:['user_id'],
          compose_drafts:['user_id'],messages:['mailbox_id'],inbound_receipts:['mailbox_id']
        };
        const fkInspectionAvailable=[...foreignKeys.values()].some(groups=>groups.length>0);
        if(!fkInspectionAvailable){
          for(const [table,cols] of Object.entries(directFallback)){
            if(!tableSet.has(table))continue;
            if(table==='messages'&&hasColumn(table,'mailbox_id'))conditionByTable.set(table,`EXISTS (SELECT 1 FROM ${quoteIdent('mailboxes')} WHERE ${quoteIdent('messages')}.${quoteIdent('mailbox_id')} = ${quoteIdent('mailboxes')}.${quoteIdent('id')} AND ${quoteIdent('mailboxes')}.${quoteIdent('user_id')}=?)`);
            else if(table==='inbound_receipts'&&hasColumn(table,'mailbox_id'))conditionByTable.set(table,`${quoteIdent('mailbox_id')} IN (SELECT ${quoteIdent('id')} FROM ${quoteIdent('mailboxes')} WHERE ${quoteIdent('user_id')}=?)`);
            else if(hasColumn(table,cols[0]))conditionByTable.set(table,`${quoteIdent(cols[0])}=?`);
          }
        }
        // inbound_receipts predates a declared FK and therefore needs a manual scope rule.
        if(tableSet.has('inbound_receipts')&&hasColumn('inbound_receipts','mailbox_id')&&hasColumn('mailboxes','id')&&hasColumn('mailboxes','user_id')){
          if(!conditionByTable.has('inbound_receipts'))conditionByTable.set('inbound_receipts',`${quoteIdent('mailbox_id')} IN (SELECT ${quoteIdent('id')} FROM ${quoteIdent('mailboxes')} WHERE ${quoteIdent('user_id')}=?)`);
        }
        // Keep user audit rows: their FK is SET NULL by design. Every other table in
        // this ownership closure is deleted explicitly, making non-cascading legacy FKs safe.
        const childrenByParent=new Map();
        for(const edge of edges){if(!childrenByParent.has(edge.parent))childrenByParent.set(edge.parent,[]);childrenByParent.get(edge.parent).push(edge.child)}
        const postorder=[],visiting=new Set(),visited=new Set();
        const visit=table=>{
          if(visited.has(table)||visiting.has(table))return;
          visiting.add(table);
          for(const child of childrenByParent.get(table)||[])visit(child);
          visiting.delete(table);visited.add(table);
          if(table!=='users')postorder.push(table);
        };
        visit('users');
        // Add known rows with no declared FK (e.g. receipt deduplication) before mailbox deletion.
        if(tableSet.has('inbound_receipts')&&!postorder.includes('inbound_receipts'))postorder.unshift('inbound_receipts');
        const canDeleteSql=`(role<>'super_admin' OR status<>'active' OR (SELECT count(*) FROM users WHERE role='super_admin' AND status='active')>1)`;
        const guard=`EXISTS (SELECT 1 FROM users WHERE id=? AND ${canDeleteSql})`;
        const statements=[];
        for(const table of postorder){
          if(!tableSet.has(table)||table==='users')continue;
          const condition=conditionByTable.get(table);
          if(!condition)continue;
          // Avoid malformed SQL for unsupported tables whose FK column metadata is incomplete.
          const binds=(condition.match(/\?/g)||[]).length;
          if(binds!==1)continue;
          statements.push(env.DB.prepare(`DELETE FROM ${quoteIdent(table)} WHERE (${condition}) AND ${guard}`).bind(...Array(binds).fill(id),id));
        }
        // Legacy tables without declared FKs still get explicit ownership cleanup.
        for(const [table,cols] of Object.entries(directFallback)){
          if(!tableSet.has(table)||postorder.includes(table)||table==='inbound_receipts')continue;
          const col=cols[0];
          if(table==='messages'&&hasColumn('messages','mailbox_id')){
            const condition=`${quoteIdent('mailbox_id')} IN (SELECT ${quoteIdent('id')} FROM ${quoteIdent('mailboxes')} WHERE ${quoteIdent('user_id')}=?)`;
            statements.unshift(env.DB.prepare(`DELETE FROM ${quoteIdent(table)} WHERE (${condition}) AND ${guard}`).bind(id,id));
          }else if(hasColumn(table,col)){
            statements.unshift(env.DB.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)}=? AND ${guard}`).bind(id,id));
          }
        }
        if(tableSet.has('inbound_receipts')&&conditionByTable.has('inbound_receipts')){
          const condition=conditionByTable.get('inbound_receipts');
          if((condition.match(/\?/g)||[]).length===1)statements.unshift(env.DB.prepare(`DELETE FROM ${quoteIdent('inbound_receipts')} WHERE (${condition}) AND ${guard}`).bind(id,id));
        }
        deleteStage='database-transaction';
        // D1 batch is atomic. Child-owned rows are deleted before their parents, followed
        // by a guarded user DELETE to protect the final active Super Admin.
        statements.push(env.DB.prepare(`DELETE FROM users WHERE id=? AND ${canDeleteSql}`).bind(id));
        results=await env.DB.batch(statements);
        if(Number(results?.[results.length-1]?.meta?.changes||0)!==1)return badRequest('Không thể xóa Siêu quản trị viên cuối cùng đang hoạt động.');
      }catch(error){
        const raw=String(error?.message||error||'');
        const code=/foreign.?key|constraint.*failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(raw)?'ADMIN_DELETE_FK':/no such (table|column)|has no column named/i.test(raw)?'ADMIN_DELETE_SCHEMA':/unique constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(raw)?'ADMIN_DELETE_CONFLICT':/locked|busy|timeout/i.test(raw)?'ADMIN_DELETE_BUSY':'ADMIN_DELETE_FAILED';
        const safeMessage=code==='ADMIN_DELETE_FK'?'Cơ sở dữ liệu còn dữ liệu liên kết ngoài danh mục đã nhận diện. Hãy thử lại sau khi đồng bộ các bảng liên quan.':code==='ADMIN_DELETE_SCHEMA'?'Cấu trúc cơ sở dữ liệu đang khác phiên bản ứng dụng; thao tác xóa đã được hủy an toàn.':code==='ADMIN_DELETE_CONFLICT'?'Dữ liệu tài khoản đang xung đột với bản ghi khác.':code==='ADMIN_DELETE_BUSY'?'Cơ sở dữ liệu đang bận; vui lòng thử lại.':'Máy chủ chưa hoàn tất giao dịch xóa; dữ liệu chưa được xác nhận là đã xóa.';
        console.error('ADMIN_USER_DELETE_FAILED',{id,actorUserId:user.id,stage:deleteStage,code,message:raw,stack:error?.stack||''});
        // The diagnostic is shown only to the authenticated administrator calling this API;
        // it contains the failing stage and short database message, not query parameters.
        return json({ok:false,deleted:false,code,stage:deleteStage,error:safeMessage,detail:raw.slice(0,240)},500);
      }
      // The user row is now deleted. Follow-up audit and object cleanup must never turn a committed deletion into a false failure.
      try{await audit(env,user.id,'admin.user.deleted','user',id,{email:target.email})}
      catch(error){console.error('ADMIN_USER_DELETE_AUDIT_FAILED',{id,actorUserId:user.id,message:error?.message||String(error)})}
      let cleanupWarnings=0;
      for(const key of [...new Set(objects)]){
        try{await deleteObjectIfUnreferenced(env,key)}
        catch(error){cleanupWarnings++;console.error('ADMIN_USER_POST_DELETE_CLEANUP_FAILED',{id,key,message:error?.message||String(error)})}
      }
      return json({ok:true,deleted:true,cleanupWarnings});
    }
    const reset=path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);if(reset&&request.method==='POST'){
      const id=Number(reset[1]),target=await env.DB.prepare(`SELECT id,role FROM users WHERE id=?`).bind(id).first();
      if(!target)return notFound('Không tìm thấy tài khoản.');
      if(target.role!=='user'&&user.role!=='super_admin')return forbidden('Chỉ Siêu quản trị viên được quản lý mật khẩu tài khoản quản trị.');
      const b=await bodyJson(request),p=String(b.password||'');if(p.length<10||p.length>1024)return badRequest('Mật khẩu phải từ 10 đến 1.024 ký tự.');
      const hp=await hashPassword(p);await env.DB.prepare(`UPDATE users SET password_salt=?,password_hash=?,password_iterations=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(hp.salt,hp.hash,hp.iterations,id).run();
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();try{await notify(env,id,'Mật khẩu đã được đặt lại','Quản trị viên đã đặt lại mật khẩu tài khoản.','security')}catch(error){console.error('ADMIN_PASSWORD_RESET_NOTIFY_FAILED',{id,message:error?.message||String(error)})}try{await audit(env,user.id,'admin.password.reset','user',id)}catch(error){console.error('ADMIN_PASSWORD_RESET_AUDIT_FAILED',{id,actorUserId:user.id,message:error?.message||String(error)})}return json({ok:true})
    }
    if(path==='/api/admin/aliases'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT a.*,mb.address mailbox_address,u.display_name FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id JOIN users u ON u.id=mb.user_id ORDER BY a.created_at DESC`).all();return json({ok:true,aliases:r.results||[]})}
    if(path==='/api/admin/aliases'&&request.method==='POST'){const b=await bodyJson(request),addr=normalizeEmail(b.address),mbid=Number(b.mailboxId||0);if(!validEmail(addr)||!mbid)return badRequest('Dữ liệu alias không hợp lệ.');const aliasDomain=addr.split('@')[1]||'';const allowedAliasDomain=await env.DB.prepare(`SELECT id FROM managed_domains WHERE lower(domain)=lower(?) LIMIT 1`).bind(aliasDomain).first();if(!allowedAliasDomain)return badRequest('Tên miền alias chưa được thêm trong Quản trị > Tên miền.');try{const r=await env.DB.prepare(`INSERT INTO aliases(mailbox_id,address,is_active) VALUES(?,?,1)`).bind(mbid,addr).run();await audit(env,user.id,'admin.alias.created','alias',r.meta.last_row_id,{address:addr,mailboxId:mbid});return json({ok:true,id:r.meta.last_row_id})}catch{return badRequest('Alias đã tồn tại hoặc mailbox không hợp lệ.')}}
    const aam=path.match(/^\/api\/admin\/aliases\/(\d+)$/);
    if(aam&&request.method==='PATCH'){const id=Number(aam[1]),b=await bodyJson(request);await env.DB.prepare(`UPDATE aliases SET is_active=? WHERE id=?`).bind(boolInt(b.isActive),id).run();await audit(env,user.id,'admin.alias.updated','alias',id,{isActive:!!b.isActive});return json({ok:true})}
    if(aam&&request.method==='DELETE'){const id=Number(aam[1]);await env.DB.prepare(`DELETE FROM aliases WHERE id=?`).bind(id).run();await audit(env,user.id,'admin.alias.deleted','alias',id);return json({ok:true})}
    if(path==='/api/admin/domains'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM managed_domains ORDER BY domain`).all();return json({ok:true,domains:r.results||[]})}
    if(path==='/api/admin/domains'&&request.method==='POST'){
      const b=await bodyJson(request),domain=String(b.domain||'').trim().toLowerCase().replace(/^@/,'');
      if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))return badRequest('Tên miền không hợp lệ.');
      try{const token=crypto.randomUUID().replaceAll('-','');const transport=['resend','gateway'].includes(String(b.transport||''))?String(b.transport):'resend';const r=await env.DB.prepare(`INSERT INTO managed_domains(domain,status,receive_enabled,send_enabled,transport,verification_token) VALUES(?,?,?,?,?,?)`).bind(domain,'pending_verification',boolInt(b.receiveEnabled??true),0,transport,token).run();await audit(env,user.id,'admin.domain.created','domain',r.meta.last_row_id,{domain,transport});return json({ok:true,id:r.meta.last_row_id,domain,verification:{type:'TXT',name:`_skyfirst-mail.${domain}`,value:`skyfirst-mail-verification=${token}`}})}catch{return badRequest('Tên miền này đã được thêm.')}
    }
    const adv=path.match(/^\/api\/admin\/domains\/(\d+)\/verify$/);if(adv&&request.method==='POST'){
      const id=Number(adv[1]);let domain=await env.DB.prepare(`SELECT * FROM managed_domains WHERE id=?`).bind(id).first();if(!domain)return notFound();
      // Pre-V12 domains have no token, so allow the admin to mint one instead of leaving them permanently unverifiable.
      if(!domain.verification_token){const token=crypto.randomUUID().replaceAll('-','');await env.DB.prepare(`UPDATE managed_domains SET verification_token=?,status='pending_verification',send_enabled=0 WHERE id=? AND (verification_token IS NULL OR verification_token='')`).bind(token,id).run();domain=await env.DB.prepare(`SELECT * FROM managed_domains WHERE id=?`).bind(id).first();}
      const requiredRecord={type:'TXT',name:`_skyfirst-mail.${domain.domain}`,value:`skyfirst-mail-verification=${domain.verification_token}`};
      try{const health=await domainHealth(domain);const verified=health.ownership;await env.DB.prepare(`UPDATE managed_domains SET status=?,verified_at=CASE WHEN ? THEN COALESCE(verified_at,CURRENT_TIMESTAMP) ELSE NULL END,last_checked_at=CURRENT_TIMESTAMP,health_json=? WHERE id=?`).bind(verified?'verified':'pending_verification',verified?1:0,JSON.stringify(health),id).run();await audit(env,user.id,'admin.domain.verified','domain',id,{verified,health});return json({ok:true,verified,health,requiredRecord,message:verified?'Đã xác minh quyền sở hữu tên miền.':'Chưa tìm thấy bản ghi TXT khớp chính xác; hãy thêm bản ghi được cung cấp và thử lại.'})}catch(e){console.error('DOMAIN_VERIFY_FAILED',{domainId:id,message:e?.message||String(e)});return json({ok:false,error:'Không kiểm tra được DNS lúc này.',requiredRecord},502)}
    }
    const adh=path.match(/^\/api\/admin\/domains\/(\d+)\/health$/);if(adh&&request.method==='GET'){
      const id=Number(adh[1]),domain=await env.DB.prepare(`SELECT * FROM managed_domains WHERE id=?`).bind(id).first();if(!domain)return notFound();const health=await domainHealth(domain);await env.DB.prepare(`UPDATE managed_domains SET last_checked_at=CURRENT_TIMESTAMP,health_json=? WHERE id=?`).bind(JSON.stringify(health),id).run();return json({ok:true,domain:domain.domain,status:domain.status,transport:domain.transport,inboundAdapter:domain.inbound_adapter,health});
    }
    const adm=path.match(/^\/api\/admin\/domains\/(\d+)$/);if(adm&&request.method==='PATCH'){
      const id=Number(adm[1]),existing=await env.DB.prepare(`SELECT * FROM managed_domains WHERE id=?`).bind(id).first();if(!existing)return notFound('Không tìm thấy tên miền.');
      const b=await bodyJson(request),f=[],v=[];if('receiveEnabled' in b){f.push('receive_enabled=?');v.push(boolInt(b.receiveEnabled))}
      if('sendEnabled' in b){if(b.sendEnabled&&existing.status!=='verified')return badRequest('Phải xác minh quyền sở hữu tên miền trước khi bật gửi.');if(b.sendEnabled){const transport=String(b.transport||existing.transport||'resend');if(transport==='resend'&&!env.RESEND_API_KEY)return badRequest('Chưa cấu hình RESEND_API_KEY.');if(transport==='gateway'&&(!env.MTA_GATEWAY_URL||!env.MTA_GATEWAY_TOKEN))return badRequest('Chưa cấu hình MTA Gateway.');}f.push('send_enabled=?');v.push(boolInt(b.sendEnabled))}
      if('transport' in b){const t=String(b.transport);if(!['resend','gateway'].includes(t))return badRequest('Transport không hợp lệ.');if(existing.send_enabled&&t==='resend'&&!env.RESEND_API_KEY)return badRequest('Chưa cấu hình RESEND_API_KEY.');if(existing.send_enabled&&t==='gateway'&&(!env.MTA_GATEWAY_URL||!env.MTA_GATEWAY_TOKEN))return badRequest('Chưa cấu hình MTA Gateway.');f.push('transport=?');v.push(t)}
      if(!f.length)return badRequest('Không có thay đổi.');await env.DB.prepare(`UPDATE managed_domains SET ${f.join(',')} WHERE id=?`).bind(...v,id).run();await audit(env,user.id,'admin.domain.updated','domain',id,b);return json({ok:true})
    }
    if(path==='/api/admin/audit'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT a.*,u.email user_email,u.display_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`).all();return json({ok:true,logs:r.results||[]})}
  }

  return notFound();
}


async function handleInboundEmail(message, env, ctx) {
  const recipient = String(message.to || '').trim().toLowerCase();
  const sender = String(message.from || '').trim();
  let storageKey = null;
  try {
    await ensureSchema(env);
    let mailbox = await env.DB.prepare(`SELECT mb.id,mb.user_id,mb.address FROM mailboxes mb JOIN users u ON u.id=mb.user_id WHERE lower(mb.address)=lower(?) AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(recipient).first();
    if (!mailbox) {
      try { mailbox = await env.DB.prepare(`SELECT mb.id,mb.user_id,mb.address FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id JOIN users u ON u.id=mb.user_id WHERE lower(a.address)=lower(?) AND a.is_active=1 AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(recipient).first(); } catch {}
    }
    if (!mailbox) { message.setReject('Mailbox does not exist.'); return; }
    const recipientDomain=recipient.split('@').pop()||'';
    const managedDomain=await env.DB.prepare(`SELECT receive_enabled,status FROM managed_domains WHERE lower(domain)=lower(?) LIMIT 1`).bind(recipientDomain).first();
    if(!managedDomain||Number(managedDomain.receive_enabled)!==1||managedDomain.status==='disabled'){message.setReject('Receiving is not configured or is disabled for this domain.');return;}

    const subject = String(message.headers.get('subject') || '(Không có tiêu đề)').slice(0,998);
    const messageId = String(message.headers.get('message-id') || '').trim() || null;
    const sentAt = normalizeMessageDate(message.headers.get('date'));
    let folder='inbox', starred=0;
    try {
      const rules=await env.DB.prepare(`SELECT sender_contains,subject_contains,action_folder,action_star FROM mail_rules WHERE user_id=? AND is_active=1 AND (mailbox_id IS NULL OR mailbox_id=?) ORDER BY id ASC`).bind(mailbox.user_id,mailbox.id).all();
      for(const r of rules.results||[]){const senderOk=!r.sender_contains||sender.toLowerCase().includes(String(r.sender_contains).toLowerCase());const subjectOk=!r.subject_contains||subject.toLowerCase().includes(String(r.subject_contains).toLowerCase());if(senderOk&&subjectOk){if(['inbox','spam','trash'].includes(r.action_folder))folder=r.action_folder;if(r.action_star)starred=1}}
    } catch (e) { console.warn('INBOUND_RULES_SKIPPED',{mailboxId:mailbox.id,message:e?.message||String(e)}); }

    // Enforce the 25 MiB limit while streaming so an oversized message is not fully buffered in memory.
    let rawEmail;
    try{rawEmail=await readStreamBounded(message.raw,25*1024*1024)}catch(e){if(e?.status===413){message.setReject('Message exceeds Sky First Mail 25 MiB inbound limit.');return}throw e;}
    const contentSha256=await digest(rawEmail);
    const receiptIdentity=messageId?`message-id:${normalizeContentId(messageId)}`:`raw:${contentSha256}`;
    const receiptDigest=await digest(new TextEncoder().encode(receiptIdentity));
    // Keep only a bounded receipt window; this table de-duplicates provider retries, not the whole mailbox lifetime.
    await env.DB.prepare(`DELETE FROM inbound_receipts WHERE created_at<datetime('now','-30 days')`).run();
    storageKey=`messages/inbound/${mailbox.id}/${Date.now()}-${crypto.randomUUID()}.eml`;
    await env.MAIL_STORAGE.put(storageKey,rawEmail,{httpMetadata:{contentType:'message/rfc822'},customMetadata:{recipient,sender}});

    // Atomically claim the receipt and create the message. `changes()` observes the immediately preceding
    // INSERT OR IGNORE, so concurrent provider retries cannot create two messages for the same receipt.
    const results=await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO inbound_receipts(mailbox_id,digest) VALUES(?,?)`).bind(mailbox.id,receiptDigest),
      env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,message_id_header,sender,recipients_json,subject,preview,storage_key,raw_size,content_sha256,hash_recorded_at,is_read,is_starred,status,sent_at,received_at) SELECT ?, 'inbound',?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,0,?,'received',?,CURRENT_TIMESTAMP WHERE changes()=1`).bind(mailbox.id,folder,messageId,sender,JSON.stringify([recipient]),subject,'',storageKey,rawEmail.byteLength,contentSha256,starred,sentAt)
    ]);
    const receiptInserted=Number(results?.[0]?.meta?.changes||0)===1;
    const messageInserted=Number(results?.[1]?.meta?.changes||0)===1;
    if(!receiptInserted||!messageInserted){
      await deleteObjectIfUnreferenced(env,storageKey);storageKey=null;
      console.log('MAIL_DUPLICATE_SKIPPED',{mailboxId:mailbox.id,messageId:messageId||null,receipt:receiptDigest});
      return;
    }
    const storedId=Number(results?.[1]?.meta?.last_row_id||0)||null;
    try{await env.DB.prepare(`INSERT INTO notifications(user_id,type,title,body) VALUES(?,'mail',?,?)`).bind(mailbox.user_id,`Thư mới từ ${sender}`,subject).run()}catch{}
    console.log('MAIL_RECEIVED',{id:storedId,from:sender,to:recipient,subject,folder,storageKey,size:rawEmail.byteLength});
  } catch (error) {
    if(storageKey)await deleteObjectIfUnreferenced(env,storageKey);
    console.error('MAIL_RECEIVE_FAILED',{from:sender,to:recipient,message:error?.message||String(error)});
    message.setReject('Temporary mail processing error.');
  }
}

export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url);
      if(url.pathname.startsWith('/api/')){
        if(!['GET','HEAD','OPTIONS'].includes(request.method)){
          const origin=request.headers.get('Origin');
          if(origin){let supplied;try{supplied=new URL(origin).origin}catch{return json({ok:false,error:'Origin không hợp lệ.'},403)}if(supplied!==url.origin)return json({ok:false,error:'Yêu cầu ghi dữ liệu khác nguồn bị từ chối.'},403)}
        }
        if(['POST','PUT','PATCH','DELETE'].includes(request.method)){
          const bodyLimit=url.pathname==='/api/compose'||url.pathname==='/api/drafts'?16*1024*1024:url.pathname==='/api/profile/avatar'?6*1024*1024:url.pathname==='/api/templates'?2*1024*1024:1024*1024;
          try{request=await boundedRequest(request,bodyLimit)}catch(e){
            if(e?.status===413){const h=new Headers({'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','permissions-policy':'camera=(), microphone=(), geolocation=()','cache-control':'no-store'});return new Response(JSON.stringify({ok:false,error:'Nội dung yêu cầu vượt quá giới hạn cho phép.'}),{status:413,headers:h})}
            throw e;
          }
        }
        await ensureSchema(env);const response=await routeApi(request,env);const h=new Headers(response.headers);h.set('x-content-type-options','nosniff');h.set('referrer-policy','no-referrer');h.set('x-frame-options','DENY');h.set('permissions-policy','camera=(), microphone=(), geolocation=()');h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
      }
      return env.ASSETS.fetch(request)
    }catch(e){
      const raw=String(e?.message||e||'');
      let routePath='';try{routePath=new URL(request.url).pathname}catch{}
      console.error('APP_ERROR',{method:request.method,path:routePath,message:raw,stack:e?.stack||''});
      if(routePath.startsWith('/api/admin/users')){
        const code=/foreign key/i.test(raw)?'ADMIN_USER_FK':/no such (table|column)/i.test(raw)?'ADMIN_USER_SCHEMA':/unique constraint/i.test(raw)?'ADMIN_USER_DUPLICATE':'ADMIN_USER_WRITE_FAILED';
        const error=code==='ADMIN_USER_FK'?'Cơ sở dữ liệu đang còn dữ liệu liên kết; thay đổi đã bị từ chối.':code==='ADMIN_USER_SCHEMA'?'Cơ sở dữ liệu chưa đồng bộ với mã nguồn hiện tại.':code==='ADMIN_USER_DUPLICATE'?'Email hoặc dữ liệu tài khoản đã tồn tại.':'Máy chủ gặp lỗi khi xử lý tài khoản. Không coi thao tác là thành công nếu chưa có xác nhận.';
        return json({ok:false,error,code},500)
      }
      return json({ok:false,error:'Sky First Mail chưa thể hoàn tất yêu cầu. Vui lòng thử lại.',code:'APP_REQUEST_FAILED'},500)
    }
  },
  async email(message,env,ctx){return handleInboundEmail(message,env,ctx)}
};

