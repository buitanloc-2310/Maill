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

async function audit(env,userId,action,targetType=null,targetId=null,metadata={}){
  try{await env.DB.prepare(`INSERT INTO audit_logs(user_id,action,target_type,target_id,metadata_json) VALUES(?,?,?,?,?)`).bind(userId||null,action,targetType,targetId==null?null:String(targetId),JSON.stringify(metadata||{})).run()}catch{}
}
async function notify(env,userId,title,body='',type='system'){
  try{await env.DB.prepare(`INSERT INTO notifications(user_id,type,title,body) VALUES(?,?,?,?)`).bind(userId,type,title,body).run()}catch{}
}
async function setupDone(env){const r=await env.DB.prepare(`SELECT value_json FROM settings WHERE key='setup_completed' LIMIT 1`).first();if(!r)return false;try{return JSON.parse(r.value_json)===true}catch{return r.value_json==='true'}}
async function markSetup(env){await env.DB.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('setup_completed','true',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json='true',updated_at=CURRENT_TIMESTAMP`).run()}
async function ownsMessage(env,userId,id){return env.DB.prepare(`SELECT m.* FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE m.id=? AND mb.user_id=? LIMIT 1`).bind(id,userId).first()}
async function ownsMailbox(env,userId,id){return env.DB.prepare(`SELECT * FROM mailboxes WHERE id=? AND user_id=? LIMIT 1`).bind(id,userId).first()}
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
    const b=await bodyJson(request), name=String(b.displayName||'').trim(), email=normalizeEmail(b.email), password=String(b.password||'');
    if(name.length<2)return badRequest('Tên hiển thị quá ngắn.'); if(!validEmail(email))return badRequest('Email không hợp lệ.'); if(password.length<10)return badRequest('Mật khẩu tối thiểu 10 ký tự.');
    const hp=await hashPassword(password); let userId; const ex=await env.DB.prepare(`SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).first();
    if(ex){userId=ex.id;await env.DB.prepare(`UPDATE users SET display_name=?,password_salt=?,password_hash=?,password_iterations=?,role='super_admin',status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(name,hp.salt,hp.hash,hp.iterations,userId).run()}
    else{const r=await env.DB.prepare(`INSERT INTO users(email,display_name,password_salt,password_hash,password_iterations,role,status) VALUES(?,?,?,?,?,'super_admin','active')`).bind(email,name,hp.salt,hp.hash,hp.iterations).run();userId=r.meta.last_row_id}
    await env.DB.batch([env.DB.prepare(`INSERT OR IGNORE INTO mailboxes(user_id,address,display_name,is_primary,is_active) VALUES(?,?,?,1,1)`).bind(userId,email,name),env.DB.prepare(`INSERT OR IGNORE INTO user_preferences(user_id) VALUES(?)`).bind(userId)]);
    await markSetup(env);await notify(env,userId,'Chào mừng đến Sky First Mail','Tài khoản Super Admin đã được khởi tạo.','welcome');await audit(env,userId,'bootstrap.completed','user',userId,{email});
    const s=await createSession(env,userId,request);return json({ok:true},200,{'set-cookie':s.header});
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
  const av=path.match(/^\/api\/avatar\/(\d+)$/);
  if(av&&request.method==='GET'){const t=await env.DB.prepare(`SELECT avatar_key FROM users WHERE id=?`).bind(Number(av[1])).first();if(!t?.avatar_key)return notFound();const o=await env.MAIL_STORAGE.get(t.avatar_key);if(!o)return notFound();const h=new Headers();o.writeHttpMetadata(h);h.set('cache-control','private,max-age=300');return new Response(o.body,{headers:h})}

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

  if(path==='/api/signatures'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM signatures WHERE user_id=? ORDER BY is_default DESC,id`).bind(user.id).all();return json({ok:true,signatures:r.results||[]})}
  if(path==='/api/signatures'&&request.method==='POST'){if(user.allow_signature_change===0)return forbidden('Chữ ký do quản trị viên quản lý.');const b=await bodyJson(request),name=String(b.name||'Chữ ký').trim().slice(0,80),html=cleanEmailHtml(String(b.contentHtml||'')).slice(0,20000),mailboxId=b.mailboxId?Number(b.mailboxId):null;if(mailboxId&&!await ownsMailbox(env,user.id,mailboxId))return forbidden();if(b.isDefault)await env.DB.prepare(`UPDATE signatures SET is_default=0 WHERE user_id=?`).bind(user.id).run();const r=await env.DB.prepare(`INSERT INTO signatures(user_id,mailbox_id,name,content_html,is_default) VALUES(?,?,?,?,?)`).bind(user.id,mailboxId,name,html,boolInt(b.isDefault)).run();return json({ok:true,id:r.meta.last_row_id})}

  if(path==='/api/labels'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM labels WHERE user_id=? ORDER BY name`).bind(user.id).all();return json({ok:true,labels:r.results||[]})}
  if(path==='/api/labels'&&request.method==='POST'){const b=await bodyJson(request),name=String(b.name||'').trim().slice(0,50);if(!name)return badRequest('Thiếu tên nhãn.');try{const r=await env.DB.prepare(`INSERT INTO labels(user_id,name) VALUES(?,?)`).bind(user.id,name).run();return json({ok:true,id:r.meta.last_row_id})}catch{return badRequest('Nhãn đã tồn tại.')}}
  const mlm=path.match(/^\/api\/messages\/(\d+)\/labels\/(\d+)$/);if(mlm){const m=await ownsMessage(env,user.id,Number(mlm[1]));if(!m)return notFound();const l=await env.DB.prepare(`SELECT id FROM labels WHERE id=? AND user_id=?`).bind(Number(mlm[2]),user.id).first();if(!l)return notFound();if(request.method==='POST'){await env.DB.prepare(`INSERT OR IGNORE INTO message_labels(message_id,label_id) VALUES(?,?)`).bind(m.id,l.id).run();return json({ok:true})}if(request.method==='DELETE'){await env.DB.prepare(`DELETE FROM message_labels WHERE message_id=? AND label_id=?`).bind(m.id,l.id).run();return json({ok:true})}}

  if(path==='/api/rules'&&request.method==='GET'){const r=await env.DB.prepare(`SELECT * FROM mail_rules WHERE user_id=? ORDER BY id DESC`).bind(user.id).all();return json({ok:true,rules:r.results||[]})}
  if(path==='/api/rules'&&request.method==='POST'){const b=await bodyJson(request),name=String(b.name||'Quy tắc').trim().slice(0,80),folder=FOLDERS.includes(b.actionFolder)?b.actionFolder:null;const r=await env.DB.prepare(`INSERT INTO mail_rules(user_id,mailbox_id,name,sender_contains,subject_contains,action_folder,action_star,is_active) VALUES(?,?,?,?,?,?,?,1)`).bind(user.id,b.mailboxId?Number(b.mailboxId):null,name,String(b.senderContains||'').trim()||null,String(b.subjectContains||'').trim()||null,folder,boolInt(b.actionStar)).run();return json({ok:true,id:r.meta.last_row_id})}

  if(path==='/api/compose'&&request.method==='POST'){
    const form=await request.formData();const fromMailboxId=Number(form.get('mailboxId')||0),fromMb=await ownsMailbox(env,user.id,fromMailboxId);if(!fromMb||!fromMb.is_active)return badRequest('Mailbox gửi không hợp lệ.');
    const to=String(form.get('to')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),cc=String(form.get('cc')||'').split(/[;,]/).map(normalizeEmail).filter(Boolean),subject=String(form.get('subject')||'').slice(0,998),html=cleanEmailHtml(String(form.get('html')||'')),text=String(form.get('text')||'');if(!to.length||to.some(x=>!validEmail(x))||cc.some(x=>!validEmail(x)))return badRequest('Địa chỉ người nhận không hợp lệ.');
    const attachments=form.getAll('attachments').filter(x=>x&&typeof x.arrayBuffer==='function');let total=0;for(const a of attachments){total+=a.size||0}if(total>8*1024*1024)return badRequest('Tổng tệp đính kèm tối đa 8 MB.');
    const resolved=[];for(const addr of [...to,...cc]){const mb=await resolveMailbox(env,addr);if(!mb)return json({ok:false,error:`Chưa cấu hình gửi ra ngoài cho ${addr}. Hiện Sky First Mail trên gói hiện tại chỉ gửi nội bộ giữa các mailbox trong hệ thống.`},501);resolved.push({addr,mb})}
    const raw=await buildMime({from:fromMb.address,to,cc,subject,text,html,attachments});const baseKey=`messages/internal/${Date.now()}-${crypto.randomUUID()}.eml`;await env.MAIL_STORAGE.put(baseKey,raw,{httpMetadata:{contentType:'message/rfc822'}});
    const now=new Date().toISOString();const recipientJson=JSON.stringify(to);
    const sent=await env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,subject,preview,storage_key,raw_size,is_read,status,sent_at,received_at) VALUES(?,'outbound','sent',?,?,?,?,?,?,?,1,'sent',?,?)`).bind(fromMb.id,fromMb.address,recipientJson,JSON.stringify(cc),subject,text.slice(0,180),baseKey,raw.byteLength,now,now).run();
    for(const {addr,mb} of resolved){await env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,subject,preview,storage_key,raw_size,is_read,status,sent_at,received_at) VALUES(?,'inbound','inbox',?,?,?,?,?,?,?,0,'received',?,?)`).bind(mb.id,fromMb.address,JSON.stringify([addr]),JSON.stringify(cc),subject,text.slice(0,180),baseKey,raw.byteLength,now,now).run();await notify(env,mb.user_id,`Thư mới từ ${user.display_name||fromMb.address}`,subject||'(Không có tiêu đề)','mail')}
    await audit(env,user.id,'mail.internal.sent','message',sent.meta.last_row_id,{to,cc});return json({ok:true,internal:true,messageId:sent.meta.last_row_id})
  }

  if(path.startsWith('/api/admin/')){
    if(!isAdmin(user))return forbidden();
    if(path==='/api/admin/dashboard'&&request.method==='GET'){
      const [u,m,mb,unread]=await env.DB.batch([env.DB.prepare(`SELECT count(*) n FROM users`),env.DB.prepare(`SELECT count(*) n,COALESCE(sum(raw_size),0) bytes FROM messages`),env.DB.prepare(`SELECT count(*) n FROM mailboxes WHERE is_active=1`),env.DB.prepare(`SELECT count(*) n FROM messages WHERE is_read=0 AND folder='inbox'`)]);return json({ok:true,stats:{users:u.results?.[0]?.n||0,messages:m.results?.[0]?.n||0,bytes:m.results?.[0]?.bytes||0,activeMailboxes:mb.results?.[0]?.n||0,unread:unread.results?.[0]?.n||0}})
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

export default {async fetch(request,env){try{const url=new URL(request.url);if(url.pathname.startsWith('/api/'))return await routeApi(request,env);return env.ASSETS.fetch(request)}catch(e){console.error('APP_ERROR',e);return json({ok:false,error:'Lỗi hệ thống tạm thời.'},500)}}};
