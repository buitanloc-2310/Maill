import { json, bodyJson, badRequest, unauthorized, forbidden, notFound } from './lib/http.js';
import { hashPassword, verifyPassword } from './lib/security.js';
import { createSession, currentUser, destroySession, isAdmin } from './lib/auth.js';
import { parseStoredMessage, cleanEmailHtml, buildMime } from './lib/mail.js';

const FOLDERS=['inbox','sent','drafts','spam','trash'];
const ROLES=['user','admin','super_admin'];
const normalizeEmail=v=>String(v||'').trim().toLowerCase();
const validEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v||'');
const boolInt=v=>v?1:0;
const safeRole=v=>ROLES.includes(v)?v:'user';
const parseJson=(v,fallback=[])=>{try{return JSON.parse(v??'')}catch{return fallback}};

let schemaReady=false;
async function ensureColumn(env,table,column,definition){
  const r=await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  if(!(r.results||[]).some(x=>x.name===column)) await env.DB.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
async function ensureSchema(env){
  if(schemaReady)return;
  await env.DB.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_iterations INTEGER NOT NULL DEFAULT 100000,role TEXT NOT NULL DEFAULT 'user',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS mailboxes (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,address TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT,is_primary INTEGER NOT NULL DEFAULT 1,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,mailbox_id INTEGER,direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),folder TEXT NOT NULL DEFAULT 'inbox',message_id_header TEXT,thread_key TEXT,sender TEXT NOT NULL,recipients_json TEXT NOT NULL,cc_json TEXT,bcc_json TEXT,subject TEXT,preview TEXT,storage_key TEXT NOT NULL,raw_size INTEGER NOT NULL DEFAULT 0,is_read INTEGER NOT NULL DEFAULT 0,is_starred INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'received',sent_at TEXT,received_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE SET NULL);
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
  `);
  for(const [table,column,def] of [
    ['users','avatar_key','TEXT'],['users','allow_name_change','INTEGER NOT NULL DEFAULT 1'],['users','allow_avatar_change','INTEGER NOT NULL DEFAULT 1'],['users','allow_password_change','INTEGER NOT NULL DEFAULT 1'],['users','last_login_at','TEXT'],['users','cover_key','TEXT'],['users','profile_status',"TEXT NOT NULL DEFAULT 'available'"],['users','allow_signature_change','INTEGER NOT NULL DEFAULT 1'],['users','allow_theme_change','INTEGER NOT NULL DEFAULT 1'],
    ['sessions','ip','TEXT'],['sessions','user_agent','TEXT'],['sessions','last_seen_at','TEXT'],
    ['messages','bcc_json','TEXT'],['compose_drafts','bcc_json',"TEXT NOT NULL DEFAULT '[]'"],['compose_drafts','body_html','TEXT'],['compose_drafts','sender_address','TEXT'],['compose_drafts','reply_to_message_id','INTEGER']
  ]) await ensureColumn(env,table,column,def);
  if(env.RESEND_API_KEY){try{await env.DB.prepare(`UPDATE managed_domains SET send_enabled=1,status='configured' WHERE lower(domain)=lower('skyfirst.io.vn')`).run()}catch{}}
  schemaReady=true;
}

async function audit(env,userId,action,targetType=null,targetId=null,metadata={}){
  try{await env.DB.prepare(`INSERT INTO audit_logs(user_id,action,target_type,target_id,metadata_json) VALUES(?,?,?,?,?)`).bind(userId||null,action,targetType,targetId==null?null:String(targetId),JSON.stringify(metadata||{})).run()}catch{}
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

function bytesToBase64(buffer){
  const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
  let binary=''; const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
async function sendWithResend(env,{fromAddress,fromName,to,cc,bcc,subject,html,text,attachments,headers}){
  if(!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY chưa được cấu hình trong Worker Secrets.');
  const files=[];
  for(const a of attachments||[]){
    const ab=await a.arrayBuffer();
    files.push({filename:a.name||'attachment',content:bytesToBase64(ab),content_type:a.type||'application/octet-stream'});
  }
  const payload={
    from: fromName?`${String(fromName).replace(/[<>\r\n]/g,' ').trim()} <${fromAddress}>`:fromAddress,
    to,
    subject: subject||'(Không có tiêu đề)',
    html: html||undefined,
    text: text||undefined,
    attachments: files.length?files:undefined,
    headers: headers&&Object.keys(headers).length?headers:undefined
  };
  if(cc?.length) payload.cc=cc;
  if(bcc?.length) payload.bcc=bcc;
  const res=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  let data={}; try{data=await res.json()}catch{}
  if(!res.ok){
    const msg=data?.message||data?.error||`HTTP ${res.status}`;
    throw new Error(`Resend: ${msg}`);
  }
  return data;
}

async function routeApi(request,env){
  const url=new URL(request.url), path=url.pathname;

  if(path==='/api/bootstrap/status'&&request.method==='GET') return json({ok:true,setupCompleted:await setupDone(env)});
  if(path==='/api/bootstrap'&&request.method==='POST'){
    if(await setupDone(env))return forbidden('Hệ thống đã được khởi tạo.');
    const b=await bodyJson(request), name=String(b.displayName||'').trim(), email=normalizeEmail(b.email), password=String(b.password||'');
    if(name.length<2)return badRequest('Tên hiển thị quá ngắn.');
    if(!validEmail(email))return badRequest('Email không hợp lệ.');
    if(password.length<10)return badRequest('Mật khẩu tối thiểu 10 ký tự.');

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
      console.error('BOOTSTRAP_FAILED',{stage,email,message:e?.message||String(e),stack:e?.stack||''});
      return json({ok:false,error:'Không thể khởi tạo tài khoản quản trị.',detail:`${stage}: ${e?.message||String(e)}`},500);
    }
  }
  if(path==='/api/login'&&request.method==='POST'){
    const b=await bodyJson(request),email=normalizeEmail(b.email),password=String(b.password||'');
    const u=await env.DB.prepare(`SELECT * FROM users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).first();
    if(!u||u.status!=='active'||!(await verifyPassword(password,u.password_salt,u.password_hash,u.password_iterations)))return unauthorized('Email hoặc mật khẩu không đúng.');
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
    const rows=await env.DB.prepare(`SELECT m.folder,m.is_starred,m.is_read,count(*) n FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=? GROUP BY m.folder,m.is_starred,m.is_read`).bind(user.id).all();
    const counts={inbox:0,sent:0,drafts:0,spam:0,trash:0,starred:0};let unread=0;
    for(const r of rows.results||[]){if(r.folder in counts)counts[r.folder]+=Number(r.n||0);if(r.is_starred&&r.folder!=='trash')counts.starred+=Number(r.n||0);if(r.folder==='inbox'&&!r.is_read)unread+=Number(r.n||0)}
    return json({ok:true,counts,unread});
  }
  if(path==='/api/messages/bulk'&&request.method==='POST'){
    const b=await bodyJson(request),ids=[...new Set((Array.isArray(b.ids)?b.ids:[]).map(Number).filter(Number.isInteger))].slice(0,200),action=String(b.action||'');
    if(!ids.length)return badRequest('Chưa chọn thư.');if(!['read','unread','star','unstar','spam','trash','inbox'].includes(action))return badRequest('Thao tác không hợp lệ.');
    const qs=ids.map(()=>'?').join(',');const owned=await env.DB.prepare(`SELECT m.id FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.user_id=? AND m.id IN (${qs})`).bind(user.id,...ids).all();
    const ok=(owned.results||[]).map(x=>Number(x.id));if(!ok.length)return badRequest('Không có thư hợp lệ.');const q2=ok.map(()=>'?').join(',');
    if(action==='read'||action==='unread')await env.DB.prepare(`UPDATE messages SET is_read=? WHERE id IN (${q2})`).bind(action==='read'?1:0,...ok).run();
    else if(action==='star'||action==='unstar')await env.DB.prepare(`UPDATE messages SET is_starred=? WHERE id IN (${q2})`).bind(action==='star'?1:0,...ok).run();
    else await env.DB.prepare(`UPDATE messages SET folder=? WHERE id IN (${q2})`).bind(action,...ok).run();
    await audit(env,user.id,'mail.bulk.updated','message',null,{ids:ok,action});return json({ok:true,updated:ok.length});
  }

  if(path==='/api/messages'&&request.method==='GET'){
    const folder=String(url.searchParams.get('folder')||'inbox'), mailboxId=Number(url.searchParams.get('mailboxId')||0), q=String(url.searchParams.get('q')||'').trim(), limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||50)));
    let where=`mb.user_id=?`, binds=[user.id];
    if(folder==='starred')where+=` AND m.is_starred=1 AND m.folder!='trash'`; else{where+=` AND m.folder=?`;binds.push(FOLDERS.includes(folder)?folder:'inbox')}
    if(mailboxId){where+=` AND m.mailbox_id=?`;binds.push(mailboxId)}
    if(q){where+=` AND (lower(m.sender) LIKE lower(?) OR lower(COALESCE(m.subject,'')) LIKE lower(?) OR lower(COALESCE(m.preview,'')) LIKE lower(?) OR lower(COALESCE(m.recipients_json,'')) LIKE lower(?))`;const like=`%${q}%`;binds.push(like,like,like,like)}
    const r=await env.DB.prepare(`SELECT m.id,m.mailbox_id,m.direction,m.folder,m.sender,m.recipients_json,m.subject,m.preview,m.raw_size,m.is_read,m.is_starred,m.status,m.sent_at,m.received_at,m.created_at FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE ${where} ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT ?`).bind(...binds,limit).all();
    return json({ok:true,messages:r.results||[]})
  }
  const mm=path.match(/^\/api\/messages\/(\d+)$/);
  if(mm&&request.method==='GET'){
    const row=await ownsMessage(env,user.id,Number(mm[1]));if(!row)return notFound('Không tìm thấy thư.');const p=await parseStoredMessage(env,row.storage_key);if(!p)return notFound('Không tìm thấy nội dung thư trong R2.');
    await env.DB.prepare(`UPDATE messages SET is_read=1 WHERE id=?`).bind(row.id).run();
    let labels=[];try{const lr=await env.DB.prepare(`SELECT l.id,l.name FROM labels l JOIN message_labels ml ON ml.label_id=l.id WHERE ml.message_id=?`).bind(row.id).all();labels=lr.results||[]}catch{}
    return json({ok:true,message:{...row,labels,parsed:{subject:p.subject||row.subject,from:p.from||null,to:p.to||[],cc:p.cc||[],date:p.date||row.received_at,text:p.text||'',html:cleanEmailHtml(p.html||''),attachments:(p.attachments||[]).map((a,i)=>({index:i,filename:a.filename||`attachment-${i+1}`,mimeType:a.mimeType||'application/octet-stream',size:a.content?.byteLength||0}))}}})
  }
  if(mm&&request.method==='PATCH'){
    const id=Number(mm[1]),row=await ownsMessage(env,user.id,id);if(!row)return notFound();const b=await bodyJson(request),f=[],v=[];
    if('isRead'in b){f.push('is_read=?');v.push(boolInt(b.isRead))} if('isStarred'in b){f.push('is_starred=?');v.push(boolInt(b.isStarred))} if(b.folder&&FOLDERS.includes(b.folder)){f.push('folder=?');v.push(b.folder)}
    if(!f.length)return badRequest('Không có thay đổi.');await env.DB.prepare(`UPDATE messages SET ${f.join(',')} WHERE id=?`).bind(...v,id).run();return json({ok:true})
  }
  const am=path.match(/^\/api\/messages\/(\d+)\/attachments\/(\d+)$/);
  if(am&&request.method==='GET'){
    const row=await ownsMessage(env,user.id,Number(am[1]));if(!row)return notFound();const p=await parseStoredMessage(env,row.storage_key);const a=p?.attachments?.[Number(am[2])];if(!a)return notFound('Không tìm thấy tệp đính kèm.');
    return new Response(a.content,{headers:{'content-type':a.mimeType||'application/octet-stream','content-disposition':`attachment; filename="${String(a.filename||'attachment').replace(/["\r\n]/g,'')}"`}})
  }

  if(path==='/api/profile/name'&&request.method==='PATCH'){
    if(!user.allow_name_change&&!isAdmin(user))return forbidden('Tên hiển thị do quản trị viên quản lý.');const b=await bodyJson(request),name=String(b.displayName||'').trim();if(name.length<2||name.length>80)return badRequest('Tên hiển thị không hợp lệ.');await env.DB.prepare(`UPDATE users SET display_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(name,user.id).run();await audit(env,user.id,'profile.name.updated','user',user.id);return json({ok:true})
  }
  if(path==='/api/profile/status'&&request.method==='PATCH'){
    const b=await bodyJson(request),status=['available','busy','away','offline'].includes(b.status)?b.status:'available';await env.DB.prepare(`UPDATE users SET profile_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status,user.id).run();return json({ok:true})
  }
  if(path==='/api/profile/password'&&request.method==='PATCH'){
    if(!user.allow_password_change&&!isAdmin(user))return forbidden('Mật khẩu được quản lý bởi quản trị viên.');const b=await bodyJson(request),cur=String(b.currentPassword||''),next=String(b.newPassword||'');if(next.length<10)return badRequest('Mật khẩu mới tối thiểu 10 ký tự.');if(!(await verifyPassword(cur,user.password_salt,user.password_hash,user.password_iterations)))return badRequest('Mật khẩu hiện tại không đúng.');const hp=await hashPassword(next);await env.DB.prepare(`UPDATE users SET password_salt=?,password_hash=?,password_iterations=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(hp.salt,hp.hash,hp.iterations,user.id).run();await env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND id<>?`).bind(user.id,user.session_id||0).run();await notify(env,user.id,'Mật khẩu đã được thay đổi','Các phiên đăng nhập khác đã bị đăng xuất.','security');await audit(env,user.id,'security.password.changed','user',user.id);return json({ok:true})
  }
  if(path==='/api/profile/avatar'&&request.method==='POST'){
    if(!user.allow_avatar_change&&!isAdmin(user))return forbidden('Ảnh đại diện do quản trị viên quản lý.');const form=await request.formData(),file=form.get('avatar');if(!file||typeof file.arrayBuffer!=='function')return badRequest('Thiếu ảnh đại diện.');if(!String(file.type||'').startsWith('image/'))return badRequest('Tệp phải là hình ảnh.');if(file.size>5*1024*1024)return badRequest('Ảnh tối đa 5 MB.');const ext=(file.type.split('/')[1]||'bin').replace(/[^a-z0-9]/gi,'');const key=`avatars/users/${user.id}/${Date.now()}.${ext}`;await env.MAIL_STORAGE.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type}});await env.DB.prepare(`UPDATE users SET avatar_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(key,user.id).run();await audit(env,user.id,'profile.avatar.updated','user',user.id,{key});return json({ok:true,key})
  }
  if(path==='/api/profile/avatar'&&request.method==='DELETE'){
    if(!user.allow_avatar_change&&!isAdmin(user))return forbidden('Ảnh đại diện do quản trị viên quản lý.');
    const old=user.avatar_key||null;
    await env.DB.prepare(`UPDATE users SET avatar_key=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(user.id).run();
    if(old){try{await env.MAIL_STORAGE.delete(old)}catch{}}
    await audit(env,user.id,'profile.avatar.deleted','user',user.id);
    return json({ok:true});
  }
  const av=path.match(/^\/api\/avatar\/(\d+)$/);
  if(av&&request.method==='GET'){const t=await env.DB.prepare(`SELECT avatar_key FROM users WHERE id=?`).bind(Number(av[1])).first();if(!t?.avatar_key)return notFound();const o=await env.MAIL_STORAGE.get(t.avatar_key);if(!o)return notFound();const h=new Headers();o.writeHttpMetadata(h);h.set('cache-control','private,max-age=3600');return new Response(o.body,{headers:h})}

  if(path==='/api/preferences'&&request.method==='PATCH'){
    if(user.allow_theme_change===0)return forbidden('Giao diện được quản lý bởi quản trị viên.');const b=await bodyJson(request),theme=['light','dark','system','sky'].includes(b.theme)?b.theme:'system',density=['comfortable','compact'].includes(b.density)?b.density:'comfortable',pane=['right','none'].includes(b.readingPane)?b.readingPane:'right';await env.DB.prepare(`INSERT INTO user_preferences(user_id,theme,density,reading_pane,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,density=excluded.density,reading_pane=excluded.reading_pane,updated_at=CURRENT_TIMESTAMP`).bind(user.id,theme,density,pane).run();return json({ok:true})
  }

  if(path==='/api/directory'&&request.method==='GET'){
    const q=String(url.searchParams.get('q')||'').trim(),like=`%${q}%`;const r=await env.DB.prepare(`SELECT id,email,display_name,role,avatar_key,profile_status FROM users WHERE status='active' AND (?='' OR lower(email) LIKE lower(?) OR lower(display_name) LIKE lower(?)) ORDER BY display_name LIMIT 100`).bind(q,like,like).all();return json({ok:true,people:r.results||[]})
  }
  if(path==='/api/contacts'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM contacts WHERE owner_user_id=? ORDER BY display_name,email`).bind(user.id).all();return json({ok:true,contacts:r.results||[]})}
  if(path==='/api/contacts'&&request.method==='POST'){const b=await bodyJson(request),email=normalizeEmail(b.email),name=String(b.displayName||'').trim();if(!validEmail(email))return badRequest('Email không hợp lệ.');await env.DB.prepare(`INSERT INTO contacts(owner_user_id,email,display_name,notes) VALUES(?,?,?,?) ON CONFLICT(owner_user_id,email) DO UPDATE SET display_name=excluded.display_name,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).bind(user.id,email,name,String(b.notes||'')).run();return json({ok:true})}

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
  if(path==='/api/rules'&&request.method==='POST'){const b=await bodyJson(request),name=String(b.name||'Quy tắc').trim().slice(0,80),folder=FOLDERS.includes(b.actionFolder)?b.actionFolder:null;const r=await env.DB.prepare(`INSERT INTO mail_rules(user_id,mailbox_id,name,sender_contains,subject_contains,action_folder,action_star,is_active) VALUES(?,?,?,?,?,?,?,1)`).bind(user.id,b.mailboxId?Number(b.mailboxId):null,name,String(b.senderContains||'').trim()||null,String(b.subjectContains||'').trim()||null,folder,boolInt(b.actionStar)).run();return json({ok:true,id:r.meta.last_row_id})}

  if(path==='/api/compose'&&request.method==='POST'){
    const form=await request.formData();const fromMailboxId=Number(form.get('mailboxId')||0),senderAddress=normalizeEmail(form.get('senderAddress')||''),fromMb=await resolveSenderIdentity(env,user.id,fromMailboxId,senderAddress);if(!fromMb)return badRequest('Địa chỉ gửi không hợp lệ hoặc bạn không có quyền sử dụng.');
    const to=String(form.get('to')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),cc=String(form.get('cc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),bcc=String(form.get('bcc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),subject=String(form.get('subject')||'').slice(0,998),html=cleanEmailHtml(String(form.get('html')||'')).slice(0,500000),text=String(form.get('text')||'').slice(0,500000);if(!to.length||[...to,...cc,...bcc].some(x=>!validEmail(x)))return badRequest('Địa chỉ người nhận không hợp lệ.');
    const attachments=form.getAll('attachments').filter(x=>x&&typeof x.arrayBuffer==='function');let total=0;for(const a of attachments)total+=a.size||0;if(total>8*1024*1024)return badRequest('Tổng tệp đính kèm tối đa 8 MB.');
    let inReplyTo=null,references=[];const replyToMessageId=Number(form.get('replyToMessageId')||0);if(replyToMessageId){const original=await ownsMessage(env,user.id,replyToMessageId);if(original){inReplyTo=original.message_id_header||null;references=inReplyTo?[inReplyTo]:[]}}
    const generatedMessageId=`<${crypto.randomUUID()}@skyfirst.io.vn>`,groups={to:[],cc:[],bcc:[]};for(const [kind,list] of Object.entries({to,cc,bcc}))for(const addr of list){const mb=await resolveMailbox(env,addr);groups[kind].push({addr,mb})}const external=kind=>groups[kind].filter(x=>!x.mb).map(x=>x.addr);
    let resendId=null;if(external('to').length||external('cc').length||external('bcc').length){try{const headers={};if(inReplyTo){headers['In-Reply-To']=inReplyTo;headers['References']=references.join(' ')}const r=await sendWithResend(env,{fromAddress:fromMb.sender_address,fromName:user.display_name||fromMb.display_name,to:external('to'),cc:external('cc'),bcc:external('bcc'),subject,html,text,attachments,headers});resendId=r?.id||null}catch(e){console.error('OUTBOUND_SEND_FAILED',{from:fromMb.sender_address,to:external('to'),cc:external('cc'),bccCount:external('bcc').length,message:e?.message||String(e)});return json({ok:false,error:`Không gửi được email ra ngoài. ${e?.message||e}`},502)}}
    const raw=await buildMime({from:fromMb.sender_address,to,cc,bcc,subject,text,html,attachments,messageId:generatedMessageId,inReplyTo,references});const baseKey=`messages/outbound/${Date.now()}-${crypto.randomUUID()}.eml`;await env.MAIL_STORAGE.put(baseKey,raw,{httpMetadata:{contentType:'message/rfc822'},customMetadata:{provider:resendId?'resend':'internal',resendId:resendId||''}});const now=new Date().toISOString(),preview=(text||html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).slice(0,180);
    const sent=await env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,bcc_json,subject,preview,storage_key,raw_size,is_read,status,sent_at,received_at,message_id_header,thread_key) VALUES(?,'outbound','sent',?,?,?,?,?,?,?,?,1,'sent',?,?,?,?)`).bind(fromMb.id,fromMb.sender_address,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,preview,baseKey,raw.byteLength,now,now,generatedMessageId,inReplyTo||generatedMessageId).run();
    if(resendId)try{await env.DB.prepare(`INSERT INTO delivery_events(message_id,provider,provider_message_id,event_type,detail_json) VALUES(?,'resend',?,'accepted',?)`).bind(sent.meta.last_row_id,resendId,JSON.stringify({to:external('to'),cc:external('cc'),bccCount:external('bcc').length})).run()}catch{}
    const delivered=new Set();for(const {addr,mb} of [...groups.to,...groups.cc,...groups.bcc].filter(x=>x.mb)){if(delivered.has(mb.id))continue;delivered.add(mb.id);await env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,bcc_json,subject,preview,storage_key,raw_size,is_read,status,sent_at,received_at,message_id_header,thread_key) VALUES(?,'inbound','inbox',?,?,?,?,?,?,?,?,0,'received',?,?,?,?)`).bind(mb.id,fromMb.sender_address,JSON.stringify([addr]),JSON.stringify(cc),JSON.stringify([]),subject,preview,baseKey,raw.byteLength,now,now,generatedMessageId,inReplyTo||generatedMessageId).run();await notify(env,mb.user_id,`Thư mới từ ${user.display_name||fromMb.sender_address}`,subject||'(Không có tiêu đề)','mail')}
    await audit(env,user.id,resendId?'mail.external.sent':'mail.internal.sent','message',sent.meta.last_row_id,{from:fromMb.sender_address,to,cc,bccCount:bcc.length,resendId,replyToMessageId:replyToMessageId||null});return json({ok:true,internal:!resendId,external:!!resendId,resendId,messageId:sent.meta.last_row_id})
  }


  // V4 reliability + productivity endpoints
  if(path==='/api/health'&&request.method==='GET'){
    return json({ok:true,service:'Sky First Mail',version:'5.0',time:new Date().toISOString(),outbound:!!env.RESEND_API_KEY,storage:!!env.MAIL_STORAGE});
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
    const form=await request.formData();const id=Number(form.get('draftId')||0),mailboxId=Number(form.get('mailboxId')||0),mb=await ownsMailbox(env,user.id,mailboxId);if(!mb)return badRequest('Mailbox không hợp lệ.');
    const to=String(form.get('to')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),cc=String(form.get('cc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),bcc=String(form.get('bcc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),subject=String(form.get('subject')||'').slice(0,998),text=String(form.get('text')||'').slice(0,500000),html=cleanEmailHtml(String(form.get('html')||'')).slice(0,500000),senderAddress=normalizeEmail(form.get('senderAddress')||mb.address),replyToMessageId=Number(form.get('replyToMessageId')||0)||null;
    const attachments=form.getAll('attachments').filter(x=>x&&typeof x.arrayBuffer==='function');let total=0;for(const a of attachments)total+=a.size||0;if(total>8*1024*1024)return badRequest('Tổng tệp đính kèm tối đa 8 MB.');
    let storageKey=null,names=attachments.map(a=>String(a.name||'attachment').slice(0,180));
    if(attachments.length){const raw=await buildMime({from:senderAddress||mb.address,to:to.length?to:[mb.address],cc,bcc,subject,text,html,attachments});storageKey=`drafts/${user.id}/${Date.now()}-${crypto.randomUUID()}.eml`;await env.MAIL_STORAGE.put(storageKey,raw,{httpMetadata:{contentType:'message/rfc822'}})}
    if(id){const old=await env.DB.prepare(`SELECT storage_key FROM compose_drafts WHERE id=? AND user_id=?`).bind(id,user.id).first();if(!old)return notFound('Không tìm thấy bản nháp.');await env.DB.prepare(`UPDATE compose_drafts SET mailbox_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,body_text=?,body_html=?,sender_address=?,reply_to_message_id=?,storage_key=COALESCE(?,storage_key),attachment_names_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`).bind(mailboxId,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,text,html,senderAddress,replyToMessageId,storageKey,JSON.stringify(names),id,user.id).run();if(storageKey&&old.storage_key&&old.storage_key!==storageKey){try{await env.MAIL_STORAGE.delete(old.storage_key)}catch{}}return json({ok:true,id})}
    const r=await env.DB.prepare(`INSERT INTO compose_drafts(user_id,mailbox_id,to_json,cc_json,bcc_json,subject,body_text,body_html,sender_address,reply_to_message_id,storage_key,attachment_names_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(user.id,mailboxId,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,text,html,senderAddress,replyToMessageId,storageKey,JSON.stringify(names)).run();return json({ok:true,id:r.meta.last_row_id});
  }
  const dm=path.match(/^\/api\/drafts\/(\d+)$/);
  if(dm&&request.method==='GET'){
    const d=await env.DB.prepare(`SELECT * FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).first();if(!d)return notFound('Không tìm thấy bản nháp.');return json({ok:true,draft:d});
  }
  if(dm&&request.method==='DELETE'){
    const d=await env.DB.prepare(`SELECT storage_key FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).first();await env.DB.prepare(`DELETE FROM compose_drafts WHERE id=? AND user_id=?`).bind(Number(dm[1]),user.id).run();if(d?.storage_key){try{await env.MAIL_STORAGE.delete(d.storage_key)}catch{}}return json({ok:true});
  }
  if(mm&&request.method==='DELETE'){
    const id=Number(mm[1]),row=await ownsMessage(env,user.id,id);if(!row)return notFound();if(row.folder!=='trash')return badRequest('Chỉ có thể xóa vĩnh viễn thư đang ở Thùng rác.');
    await env.DB.prepare(`DELETE FROM messages WHERE id=?`).bind(id).run();
    const refs=await env.DB.prepare(`SELECT count(*) n FROM messages WHERE storage_key=?`).bind(row.storage_key).first();if(Number(refs?.n||0)===0){try{await env.MAIL_STORAGE.delete(row.storage_key)}catch{}}
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
      return json({ok:true,architecture:{metadata:'D1 metadata only',objects:'R2 object storage',compute:'Cloudflare Workers',outbound:'Resend API'},storage:{messageBytes:Number(m?.message_bytes||0),messageCount:Number(m?.message_count||0),d1ApproxBytes:pageCount&&pageSize?Number(pageCount)*Number(pageSize):null},accounts:{users:Number(u?.user_count||0)},capabilities:{outbound:!!env.RESEND_API_KEY,inbound:true,r2:true,avatarStorage:'R2',rawMailStorage:'R2'},scale:{r2Target:'100GB+',millionAccounts:'requires sharded/external metadata database'}})
    }
    if(path==='/api/admin/users'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.role,u.status,u.avatar_key,u.allow_name_change,u.allow_avatar_change,u.allow_password_change,u.allow_signature_change,u.allow_theme_change,u.last_login_at,(SELECT count(*) FROM mailboxes mb WHERE mb.user_id=u.id) mailbox_count,(SELECT id FROM mailboxes mb2 WHERE mb2.user_id=u.id ORDER BY is_primary DESC,id LIMIT 1) primary_mailbox_id FROM users u ORDER BY u.created_at DESC`).all();return json({ok:true,users:r.results||[]})}
    if(path==='/api/admin/users'&&request.method==='POST'){
      const b=await bodyJson(request),name=String(b.displayName||'').trim(),email=normalizeEmail(b.email),password=String(b.password||'');if(name.length<2||!validEmail(email)||password.length<10)return badRequest('Kiểm tra lại tên, email và mật khẩu.');const hp=await hashPassword(password);
      try{const r=await env.DB.prepare(`INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations,role,status,allow_name_change,allow_avatar_change,allow_password_change,allow_signature_change,allow_theme_change) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(email,name,hp.salt,hp.hash,hp.iterations,safeRole(b.role),b.status==='disabled'?'disabled':'active',boolInt(b.allowNameChange),boolInt(b.allowAvatarChange),boolInt(b.allowPasswordChange??true),boolInt(b.allowSignatureChange??true),boolInt(b.allowThemeChange??true)).run();const id=r.meta.last_row_id;await env.DB.batch([env.DB.prepare(`INSERT INTO mailboxes(user_id,address,display_name,is_primary,is_active) VALUES(?,?,?,1,?)`).bind(id,email,name,b.mailboxActive===false?0:1),env.DB.prepare(`INSERT OR IGNORE INTO user_preferences(user_id) VALUES(?)`).bind(id)]);await notify(env,id,'Tài khoản Sky First đã được tạo',`Địa chỉ: ${email}`,'account');await audit(env,user.id,'admin.user.created','user',id,{email});return json({ok:true,id})}catch(e){if(String(e).toLowerCase().includes('unique'))return badRequest('Email này đã tồn tại.');throw e}
    }
    const aum=path.match(/^\/api\/admin\/users\/(\d+)$/);if(aum&&request.method==='PATCH'){
      const id=Number(aum[1]),target=await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first();if(!target)return notFound();if(target.role==='super_admin'&&user.role!=='super_admin')return forbidden('Chỉ Super Admin được sửa Super Admin.');const b=await bodyJson(request),f=[],v=[];
      if(typeof b.displayName==='string'){const n=b.displayName.trim();if(n.length<2)return badRequest('Tên quá ngắn.');f.push('display_name=?');v.push(n)}if(b.role&&ROLES.includes(b.role)){if(user.role!=='super_admin'&&b.role==='super_admin')return forbidden();f.push('role=?');v.push(b.role)}if(['active','disabled'].includes(b.status)){f.push('status=?');v.push(b.status)}
      for(const [k,c] of [['allowNameChange','allow_name_change'],['allowAvatarChange','allow_avatar_change'],['allowPasswordChange','allow_password_change'],['allowSignatureChange','allow_signature_change'],['allowThemeChange','allow_theme_change']])if(k in b){f.push(`${c}=?`);v.push(boolInt(b[k]))}
      if(!f.length)return badRequest('Không có thay đổi.');f.push('updated_at=CURRENT_TIMESTAMP');await env.DB.prepare(`UPDATE users SET ${f.join(',')} WHERE id=?`).bind(...v,id).run();await notify(env,id,'Quyền tài khoản đã được cập nhật','Quản trị viên vừa thay đổi cài đặt tài khoản của bạn.','account');await audit(env,user.id,'admin.user.updated','user',id,b);return json({ok:true})
    }
    const reset=path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);if(reset&&request.method==='POST'){const b=await bodyJson(request),p=String(b.password||'');if(p.length<10)return badRequest('Mật khẩu tối thiểu 10 ký tự.');const id=Number(reset[1]),hp=await hashPassword(p);await env.DB.prepare(`UPDATE users SET password_salt=?,password_hash=?,password_iterations=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(hp.salt,hp.hash,hp.iterations,id).run();await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();await notify(env,id,'Mật khẩu đã được đặt lại','Quản trị viên đã đặt lại mật khẩu tài khoản.','security');await audit(env,user.id,'admin.password.reset','user',id);return json({ok:true})}
    if(path==='/api/admin/aliases'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT a.*,mb.address mailbox_address,u.display_name FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id JOIN users u ON u.id=mb.user_id ORDER BY a.created_at DESC`).all();return json({ok:true,aliases:r.results||[]})}
    if(path==='/api/admin/aliases'&&request.method==='POST'){const b=await bodyJson(request),addr=normalizeEmail(b.address),mbid=Number(b.mailboxId||0);if(!validEmail(addr)||!mbid)return badRequest('Dữ liệu alias không hợp lệ.');try{const r=await env.DB.prepare(`INSERT INTO aliases(mailbox_id,address,is_active) VALUES(?,?,1)`).bind(mbid,addr).run();await audit(env,user.id,'admin.alias.created','alias',r.meta.last_row_id,{address:addr,mailboxId:mbid});return json({ok:true,id:r.meta.last_row_id})}catch{return badRequest('Alias đã tồn tại hoặc mailbox không hợp lệ.')}}
    if(path==='/api/admin/domains'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM managed_domains ORDER BY domain`).all();return json({ok:true,domains:r.results||[]})}
    if(path==='/api/admin/audit'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT a.*,u.email user_email,u.display_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`).all();return json({ok:true,logs:r.results||[]})}
  }

  return notFound();
}


async function handleInboundEmail(message, env, ctx) {
  const recipient = String(message.to || '').trim().toLowerCase();
  const sender = String(message.from || '').trim();
  try {
    await ensureSchema(env);
    let mailbox = await env.DB.prepare(`SELECT mb.id,mb.user_id,mb.address FROM mailboxes mb JOIN users u ON u.id=mb.user_id WHERE lower(mb.address)=lower(?) AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(recipient).first();
    if (!mailbox) {
      try { mailbox = await env.DB.prepare(`SELECT mb.id,mb.user_id,mb.address FROM aliases a JOIN mailboxes mb ON mb.id=a.mailbox_id JOIN users u ON u.id=mb.user_id WHERE lower(a.address)=lower(?) AND a.is_active=1 AND mb.is_active=1 AND u.status='active' LIMIT 1`).bind(recipient).first(); } catch {}
    }
    if (!mailbox) { message.setReject('Mailbox does not exist.'); return; }
    const subject = message.headers.get('subject') || '(Không có tiêu đề)';
    const messageId = message.headers.get('message-id') || null;
    if(messageId){const dup=await env.DB.prepare(`SELECT id FROM messages WHERE mailbox_id=? AND message_id_header=? LIMIT 1`).bind(mailbox.id,messageId).first();if(dup){console.log('MAIL_DUPLICATE_SKIPPED',{mailboxId:mailbox.id,messageId});return;}}
    const sentAt = message.headers.get('date') || null;
    let folder='inbox', starred=0;
    try {
      const rules=await env.DB.prepare(`SELECT sender_contains,subject_contains,action_folder,action_star FROM mail_rules WHERE user_id=? AND is_active=1 AND (mailbox_id IS NULL OR mailbox_id=?) ORDER BY id ASC`).bind(mailbox.user_id,mailbox.id).all();
      for(const r of rules.results||[]){const senderOk=!r.sender_contains||sender.toLowerCase().includes(String(r.sender_contains).toLowerCase());const subjectOk=!r.subject_contains||subject.toLowerCase().includes(String(r.subject_contains).toLowerCase());if(senderOk&&subjectOk){if(['inbox','spam','trash'].includes(r.action_folder))folder=r.action_folder;if(r.action_star)starred=1}}
    } catch {}
    const storageKey=`messages/inbound/${mailbox.id}/${Date.now()}-${crypto.randomUUID()}.eml`;
    const rawEmail=await new Response(message.raw).arrayBuffer();
    await env.MAIL_STORAGE.put(storageKey,rawEmail,{httpMetadata:{contentType:'message/rfc822'},customMetadata:{recipient,sender}});
    const result=await env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,message_id_header,sender,recipients_json,subject,preview,storage_key,raw_size,is_read,is_starred,status,sent_at,received_at) VALUES(?,'inbound',?,?,?,?,?,?,?, ?,0,?,'received',?,CURRENT_TIMESTAMP)`).bind(mailbox.id,folder,messageId,sender,JSON.stringify([recipient]),subject,'',storageKey,rawEmail.byteLength,starred,sentAt).run();
    try{await env.DB.prepare(`INSERT INTO notifications(user_id,type,title,body) VALUES(?,'mail',?,?)`).bind(mailbox.user_id,`Thư mới từ ${sender}`,subject).run()}catch{}
    console.log('MAIL_RECEIVED',{id:result.meta?.last_row_id,from:sender,to:recipient,subject,folder,storageKey,size:rawEmail.byteLength});
  } catch (error) {
    console.error('MAIL_RECEIVE_FAILED',{from:sender,to:recipient,message:error?.message||String(error)});
    message.setReject('Temporary mail processing error.');
  }
}

export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url);
      if(url.pathname.startsWith('/api/')){await ensureSchema(env);return await routeApi(request,env)}
      return env.ASSETS.fetch(request)
    }catch(e){
      console.error('APP_ERROR',{message:e?.message||String(e),stack:e?.stack||''});
      return json({ok:false,error:'Sky First Mail chưa thể hoàn tất yêu cầu. Vui lòng thử lại.',detail:String(e?.message||e)},500)
    }
  },
  async email(message,env,ctx){return handleInboundEmail(message,env,ctx)}
};

