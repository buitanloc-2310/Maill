const app=document.querySelector('#app');
const S={me:null,mailboxes:[],messages:[],folder:'inbox',selected:null,q:'',theme:'system',nextCursor:null,hasMore:false,selectedIds:new Set(),summary:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const initials=n=>String(n||'SF').trim().split(/\s+/).slice(-2).map(x=>x[0]?.toUpperCase()).join('');
const when=v=>{if(!v)return'';const d=new Date(v.includes('T')?v:v.replace(' ','T')+'Z');return isNaN(d)?v:d.toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})};
const fmt=n=>{n=Number(n||0);if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`};
const roleLabel=r=>({user:'Người dùng',admin:'Quản trị viên',super_admin:'Siêu quản trị viên'}[r]||r);
const statusLabel=r=>({active:'Hoạt động',disabled:'Đã khóa'}[r]||r);
const accountTypeLabel=t=>({personal:'Cá nhân',organization:'Tổ chức / Đơn vị',service:'Dịch vụ',delegated:'Ủy quyền',alias:'Bí danh'}[t]||'Cá nhân');
const icon=n=>({inbox:'▣',starred:'☆',important:'❗',sent:'↗',drafts:'□',spam:'!',trash:'⌫',archive:'▱',snoozed:'◷',contacts:'◎',admin:'◇'}[n]||'•');

function verifyBadgeHtml(v,compact=false){
 if(!v)return'';
 if(v.status==='spoof_warning')return`<span class="sf-spoof-badge" title="${esc(v.explanation||'Cảnh báo giả mạo SPF/DKIM/DMARC')}">⚠ Cảnh báo giả mạo</span>`;
 if(!v.isVerified)return'';
 const isOrg=v.accountType==='organization'||v.account_type==='organization';
 const isSvc=v.accountType==='service'||v.account_type==='service';
 const badgeClass=isOrg?'sf-verified-badge gold':isSvc?'sf-verified-badge service':'sf-verified-badge';
 const badgeLabel=isOrg?'Tích vàng Tổ chức':isSvc?'Dịch vụ hệ thống':'Đã xác minh';
 const tip=v.explanation||`${badgeLabel} bởi ${v.verifiedBy||'Quản trị viên Sky First'}${v.department?' · '+v.department:''}`;
 return compact
  ?`<span class="${badgeClass} icon-only" title="${esc(tip)}" aria-label="${badgeLabel}">✓</span>`
  :`<span class="${badgeClass}" title="${esc(tip)}" aria-label="${badgeLabel}">✓ ${badgeLabel}${v.department?' · '+esc(v.department):''}</span>`;
}

async function api(path,opts={}){
 const {timeoutMs=60000,signal:callerSignal,...fetchOptions}=opts;
 const isForm=fetchOptions.body instanceof FormData,controller=new AbortController();
 let timedOut=false,timer=null,onCallerAbort=null,r,d={};
 if(callerSignal){if(callerSignal.aborted)controller.abort(callerSignal.reason);else{onCallerAbort=()=>controller.abort(callerSignal.reason);callerSignal.addEventListener('abort',onCallerAbort,{once:true})}}
 if(timeoutMs>0)timer=setTimeout(()=>{timedOut=true;controller.abort()},timeoutMs);
 try{
  r=await fetch(path,{...fetchOptions,signal:controller.signal,headers:{...(isForm?{}:{'content-type':'application/json'}),...(fetchOptions.headers||{})}});
  try{d=await r.json()}catch(error){if(timedOut)throw error}
 }catch(error){
  if(timedOut){const e=new Error(`Máy chủ phản hồi quá chậm khi xử lý ${path.startsWith('/api/bootstrap')?'bước khởi tạo hộp thư':'yêu cầu'}. Bạn có thể thử kết nối lại.`);e.code='API_TIMEOUT';e.path=path;throw e}
  if(callerSignal?.aborted)throw error;
  if(error instanceof TypeError){const e=new Error('Không thể kết nối máy chủ thư điện tử. Vui lòng kiểm tra kết nối và thử lại.');e.code='NETWORK_ERROR';e.path=path;throw e}
  throw error
 }finally{if(timer)clearTimeout(timer);if(onCallerAbort)callerSignal.removeEventListener('abort',onCallerAbort)}
 if(!r.ok){const e=new Error(d.error||`HTTP ${r.status}`);e.detail=d.detail||'';e.code=d.code||'';e.stage=d.stage||'';e.status=r.status;e.payload=d;throw e}return d
}
const apiErrorText=e=>[e?.message||'Yêu cầu thất bại',e?.code?`Mã ${e.code}`:'',e?.stage?`Giai đoạn ${e.stage}`:'',e?.detail?`Chi tiết: ${String(e.detail).slice(0,240)}`:''].filter(Boolean).join(' · ');
function applyTheme(t='system'){S.theme=t;document.documentElement.dataset.theme=t;if(t==='system')document.documentElement.removeAttribute('data-theme')}
function applyLayoutWidth(w='standard'){const valid=['narrow','standard','wide'].includes(w)?w:'standard';S.layoutWidth=valid;document.documentElement.dataset.layoutWidth=valid;try{localStorage.setItem('sfm_layout_width',valid)}catch{}document.querySelectorAll('.layout-btn[data-set-width]').forEach(b=>b.classList.toggle('active',b.dataset.setWidth===valid))}
function applySidebarState(s='expanded'){const valid=s==='collapsed'?'collapsed':'expanded';S.sidebarState=valid;document.documentElement.dataset.sidebar=valid;try{localStorage.setItem('sfm_sidebar_state',valid)}catch{}}
function resetLayoutDefaults(){applyLayoutWidth('standard');applySidebarState('expanded');appNotice('Đã khôi phục bố cục mặc định.','success')}
function brand(){return`<div class="brand"><img class="brand-logo" src="/sky-first-logo.png" alt="Sky First"><div><b>SKY FIRST</b><span>TRUNG TÂM THƯ ĐIỆN TỬ</span></div></div>`}
function msg(text,type='error'){return`<div class="notice ${type}">${esc(text)}</div>`}
function modal(html,wide=false){const w=document.createElement('div');w.className='modal-wrap';w.innerHTML=`<section class="modal ${wide?'wide':''}">${html}<button class="modal-x" aria-label="Đóng">×</button></section>`;w.querySelector('.modal-x').onclick=()=>w.remove();w.onclick=e=>{if(e.target===w)w.remove()};document.body.appendChild(w);return w}
function auth(title,sub,form){app.innerHTML=`<main class="auth auth-sky"><div class="sky-orb orb-a"></div><div class="sky-orb orb-b"></div><section class="auth-shell v102-auth"><div class="auth-hero"><img class="auth-logo" src="/sky-first-logo.png" alt="Sky First"><div class="mail-wordmark">TRUNG TÂM THƯ ĐIỆN TỬ <span>SKY FIRST</span></div><div class="brand-rule"></div><h2>Kết nối con người<br>Kiến tạo giá trị · Vươn xa cùng nhau</h2><p>Không gian thư điện tử dành cho hoạt động kết nối, trao đổi và phối hợp công việc tại mail.skyfirst.io.vn.</p></div><section class="auth-card"><h1>${title}</h1><p>${sub}</p><div id="authmsg"></div>${form}<div class="auth-help">Tài khoản được cấp và quản lý bởi quản trị viên hệ thống.</div><div class="v3-trust"><span>● Gửi và nhận thư</span><span>● Đồng bộ dữ liệu</span><span>● Kết nối ổn định</span></div></section></section><section class="v102-values"><div><small>01</small><b>Giáo dục</b></div><div><small>02</small><b>Cộng đồng</b></div><div><small>03</small><b>Trách nhiệm</b></div><div><small>04</small><b>Chủ động & Phát triển</b></div><div><small>05</small><b>Kết nối & Hợp tác</b></div><div><small>06</small><b>Bền vững</b></div></section><footer class="auth-footer v102-footer"><div><b>© 2026 Trung tâm Thư điện tử Sky First (mail.skyfirst.io.vn)</b><br><span>Sản phẩm thuộc Mạng lưới Giáo dục & Phát triển Cộng đồng Sky First</span></div><div><button data-foot="privacy">Quyền riêng tư</button><span>•</span><button data-foot="terms">Điều khoản</button><span>•</span><button data-foot="support">Hỗ trợ</button></div></footer></main>`;document.querySelectorAll('[data-foot]').forEach(b=>b.onclick=()=>publicInfo(b.dataset.foot))}
function publicInfo(type){const data={privacy:['Quyền riêng tư & dữ liệu','Trung tâm Thư điện tử Sky First xử lý thông tin tài khoản và dữ liệu thư nhằm cung cấp, duy trì và bảo vệ hệ thống. Nội dung thư và thông tin tài khoản không được công khai cho người không có thẩm quyền. Người dùng có trách nhiệm bảo vệ thông tin đăng nhập. Liên hệ: support@skyfirst.io.vn'],terms:['Điều khoản sử dụng','Người dùng sử dụng tài khoản đúng mục đích được cấp; không gửi thư rác, giả mạo danh tính, phát tán nội dung trái quy định hoặc gây ảnh hưởng đến an toàn hệ thống. Tài khoản có thể bị khóa khi phát hiện sử dụng sai mục đích.'],support:['Hỗ trợ','Nếu gặp vấn đề đăng nhập, gửi/nhận thư, quên mật khẩu hoặc phát hiện hoạt động bất thường, liên hệ support@skyfirst.io.vn hoặc Hotline/Zalo 0924 910 210.']}[type]||['Trung tâm Thư điện tử Sky First',''];modal(`<div class="info-modal"><img src="/sky-first-logo.png" alt="Sky First"><h2>${data[0]}</h2><p>${data[1]}</p><button class="primary" onclick="this.closest('.modal-wrap').remove()">Đóng</button></div>`)}
function setSplashStatus(text){const p=app.querySelector('.splash-card p');if(p)p.textContent=text}
function showBootError(error){const timedOut=error?.code==='API_TIMEOUT';app.innerHTML=`<main class="auth auth-sky"><section class="fatal-card"><img src="/sky-first-logo.png" alt="Sky First"><h1>${timedOut?'Kết nối hộp thư đang chậm':'Chưa thể kết nối Trung tâm Thư điện tử Sky First'}</h1><p>${esc(error?.message||'Hệ thống chưa sẵn sàng.')}</p><p>Trang đã dừng chờ để tránh mắc kẹt ở màn hình tải. Thư và dữ liệu hiện có không bị xóa bởi thao tác thử lại.</p><button class="primary" id="retryBoot" type="button">Thử kết nối lại</button></section></main>`;app.querySelector('#retryBoot')?.addEventListener('click',()=>location.reload())}
function showMessagesError(error){const rows=document.querySelector('#rows');if(!rows)return;rows.innerHTML=`${msg(`Không tải được danh sách thư: ${error?.message||'Lỗi kết nối.'}`)}<button type="button" class="secondary load-more" id="retryMessages">Thử tải lại</button>`;rows.querySelector('#retryMessages')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;e.currentTarget.textContent='Đang tải…';try{await loadMessages()}catch(next){showMessagesError(next)}})}
async function boot(){
 try{
  setSplashStatus('Đang kiểm tra kết nối an toàn…');
  const st=await api('/api/bootstrap/status',{timeoutMs:12000});
  if(!st.setupCompleted)return setup();
  setSplashStatus('Đang xác thực phiên đăng nhập…');
  let m;try{m=await api('/api/me',{timeoutMs:12000})}catch(e){if(e.status===401)return login();throw e}
  if(!m?.user)throw new Error('Máy chủ chưa trả thông tin tài khoản hợp lệ.');
  S.me=m.user;window.S=S;applyTheme(S.me.preferences?.theme||'system');applyLayoutWidth(S.me.preferences?.density||localStorage.getItem('sfm_layout_width')||'standard');applySidebarState(localStorage.getItem('sfm_sidebar_state')||'expanded');
  setSplashStatus('Đang tải danh sách hộp thư…');
  const mb=await api('/api/mailboxes',{timeoutMs:12000});S.mailboxes=mb.mailboxes||[];
  render();
   // Live background polling: automatically check for new incoming emails every 10 seconds so user never waits!
   if(!window._sfm_poll){
     window._sfm_poll=setInterval(async()=>{
       if(!document.hidden && S.me && S.folder==='inbox' && !S.selected && !S.q){
         try{ await loadMessages(null,false,{silent:true}); await loadSummary(); }catch{}
       }
     },10000);
   }
  const rows=document.querySelector('#rows');if(rows)rows.innerHTML='<div class="empty small"><h3>Đang tải thư…</h3><p>Đang lấy danh sách thư mới nhất.</p></div>';
  try{await loadMessages(null,false,{timeoutMs:15000});loadSummary()}catch(e){if(e.status===401)return login();showMessagesError(e)}
 }catch(e){showBootError(e)}
}
function setup(){auth('Thiết lập lần đầu','Khởi tạo tài khoản Siêu quản trị viên. Cần khóa thiết lập do quản trị hạ tầng cung cấp.',`<form id="f" class="auth-form"><label>Khóa thiết lập hệ thống<div class="input-shell"><span>⌑</span><input name="setupSecret" type="password" autocomplete="off" required minlength="24" placeholder="Nhập SETUP_SECRET"></div></label><label>Họ và tên<div class="input-shell"><span>◎</span><input name="displayName" placeholder="Tên người quản trị" required></div></label><label>Email quản trị<div class="input-shell"><span>✉</span><input name="email" type="email" placeholder="admin@skyfirst.io.vn" required></div></label><label>Mật khẩu<div class="input-shell"><span>⌑</span><input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Tối thiểu 10 ký tự" required></div></label><label>Xác nhận mật khẩu<div class="input-shell"><span>✓</span><input name="confirm" type="password" minlength="10" autocomplete="new-password" placeholder="Nhập lại mật khẩu" required></div></label><button class="primary full auth-submit">Khởi tạo hệ thống <span>→</span></button></form>`);document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),a=f.get('password'),b=f.get('confirm');if(a!==b)return document.querySelector('#authmsg').innerHTML=msg('Mật khẩu xác nhận không khớp.');try{await api('/api/bootstrap',{method:'POST',headers:{'x-setup-secret':String(f.get('setupSecret')||'')},body:JSON.stringify({displayName:f.get('displayName'),email:f.get('email'),password:a})});location.reload()}catch(x){document.querySelector('#authmsg').innerHTML=msg(x.message)}}}
function login(){auth('Chào mừng trở lại','Đăng nhập để truy cập hộp thư của bạn.',`<form id="f" class="auth-form"><label>Địa chỉ email<div class="input-shell"><span>✉</span><input name="email" type="email" autocomplete="username" placeholder="Nhập địa chỉ email" required></div></label><label>Mật khẩu<div class="input-shell"><span>⌑</span><input name="password" type="password" autocomplete="current-password" placeholder="Nhập mật khẩu" required></div></label><label class="remember"><input type="checkbox" name="remember"><span>Ghi nhớ đăng nhập trên thiết bị này</span></label><button class="primary full auth-submit">Đăng nhập <span>→</span></button></form>`);document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,btn=form.querySelector('.auth-submit'),f=new FormData(form);btn.disabled=true;btn.innerHTML='<span class="login-spinner"></span> Đang xác thực…';document.querySelector('#authmsg').innerHTML='<div class="login-progress"><span></span><p>Đang kết nối hộp thư an toàn của bạn…</p></div>';try{await api('/api/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})});document.querySelector('#authmsg').innerHTML='<div class="login-success">✓ Đăng nhập thành công. Đang mở hộp thư…</div>';setTimeout(()=>location.reload(),260)}catch(x){btn.disabled=false;btn.innerHTML='Đăng nhập <span>→</span>';document.querySelector('#authmsg').innerHTML=msg(x.message)}}}
function nav(folder,label){return`<button type="button" class="navbtn ${S.folder===folder?'active':''}" data-folder="${folder}" aria-label="${label}" title="${label}"><i aria-hidden="true">${icon(folder)}</i><span>${label}</span><span class="v3-nav-count" hidden></span></button>`}
function avatar(u,cls='avatar'){const key=u?.avatarKey||u?.avatar_key;const action=cls==='top-avatar'?' role="button" tabindex="0" aria-label="Mở hồ sơ tài khoản" title="Tài khoản"':'';return key?`<img class="${cls}"${action} src="/api/avatar/${u.id}?v=${encodeURIComponent(key)}" alt="Ảnh đại diện">`:`<div class="${cls}"${action}>${esc(initials(u?.displayName||u?.display_name||u?.email))}</div>`}

async function loadSummary(){
 try{
  S.summary=await api('/api/mailbox/summary');
  const c=S.summary.counts||{};
  const map={inbox:c.inbox,starred:c.starred,sent:c.sent,drafts:c.drafts,spam:c.spam,trash:c.trash};
  document.querySelectorAll('[data-folder]').forEach(b=>{
   const badge=b.querySelector('.v3-nav-count');if(!badge)return;
   const n=Number(map[b.dataset.folder]||0);
   badge.textContent=n?String(n):'';badge.hidden=!n;
  });
  const n=Number(S.summary.unread||0),bell=document.querySelector('#notif');
  if(bell){bell.classList.toggle('has-unread',n>0);bell.dataset.count=n>99?'99+':String(n||'');}
 }catch{}
}

async function draftsModal(){
 try{
  const d=await api('/api/drafts');
  const wrap=modal(`<h2>Bản nháp đã lưu</h2><p class="muted">Sky First Mail tự lưu nội dung đang soạn để hạn chế mất dữ liệu.</p><div class="v4-drafts">${d.drafts.length?d.drafts.map(x=>`<div class="v4-draft"><div><b>${esc(x.subject||'(Không có tiêu đề)')}</b><span>${esc((JSON.parse(x.to_json||'[]')).join(', ')||'Chưa có người nhận')}</span><small>${esc(x.updated_at||'')}</small></div><button data-open="${x.id}" class="secondary">Mở</button><button data-del="${x.id}" class="v4-danger">Xóa</button></div>`).join(''):'<div class="empty"><h3>Chưa có bản nháp</h3></div>'}</div>`,true);
  wrap.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{await api(`/api/drafts/${b.dataset.del}`,{method:'DELETE'});b.closest('.v4-draft').remove();appNotice('Đã xóa bản nháp.','success')});
  wrap.querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{try{const x=await api(`/api/drafts/${b.dataset.open}`);wrap.remove();const dr=x.draft||{};if(typeof window.SkyFirstCompose==='function'){window.SkyFirstCompose({mode:'draft',draftId:Number(dr.id),to:JSON.parse(dr.to_json||'[]').join(', '),cc:JSON.parse(dr.cc_json||'[]').join(', '),bcc:JSON.parse(dr.bcc_json||'[]').join(', '),subject:dr.subject||'',text:dr.body_text||'',html:dr.body_html||'',from:dr.sender_address||'',replyToMessageId:dr.reply_to_message_id||null,savedAttachments:x.attachments||[]});appNotice('Đã khôi phục bản nháp.','success')}}catch(e){appNotice(e.message,'error')}});
 }catch(e){appNotice(e.message,'error')}
}

function mobileMore(){
 const folders=[['snoozed','Đã hoãn','Thư đang được tạm ẩn'],['archive','Lưu trữ','Thư đã lưu trữ'],['spam','Thư rác','Thư bị đưa vào mục rác'],['trash','Thùng rác','Thư đã xóa']];
 const tools=[['contacts','Danh bạ','◎'],...(S.me&&['admin','super_admin'].includes(S.me.role)?[['admin','Quản trị hệ thống','◇']]:[])];
 const w=modal(`<div class="mobile-menu"><div class="mobile-menu-heading"><div><span class="mobile-menu-kicker">SKY FIRST MAIL</span><h2>Thư mục và công cụ</h2><p>Chọn mục cần mở. Các thư mục chính vẫn nằm ở thanh dưới.</p></div></div><h3>Thư mục khác</h3><div class="mobile-menu-grid">${folders.map(([key,label,desc])=>`<button type="button" class="mobile-menu-item ${S.folder===key?'active':''}" data-mobile-folder="${key}"><span class="mobile-menu-icon">${icon(key)}</span><span class="mobile-menu-copy"><b>${label}</b><small>${desc}</small></span><span class="mobile-menu-arrow">›</span></button>`).join('')}</div><h3>Công cụ</h3><div class="mobile-menu-grid mobile-menu-tools">${tools.map(([key,label,sym])=>`<button type="button" class="mobile-menu-item" data-mobile-action="${key}"><span class="mobile-menu-icon">${sym}</span><span class="mobile-menu-copy"><b>${label}</b><small>${key==='contacts'?'Quản lý liên hệ đã lưu':'Người dùng, tên miền và hệ thống'}</small></span><span class="mobile-menu-arrow">›</span></button>`).join('')}<button type="button" class="mobile-menu-item" data-mobile-action="account"><span class="mobile-menu-icon">◎</span><span class="mobile-menu-copy"><b>Tài khoản và cài đặt</b><small>Hồ sơ, bảo mật và giao diện</small></span><span class="mobile-menu-arrow">›</span></button></div></div>`);
 w.querySelectorAll('[data-mobile-folder]').forEach(b=>b.addEventListener('click',()=>{const key=b.dataset.mobileFolder;w.remove();document.querySelector(`[data-folder="${key}"]`)?.click()}));
 w.querySelectorAll('[data-mobile-action]').forEach(b=>b.addEventListener('click',()=>{const key=b.dataset.mobileAction;w.remove();if(key==='account')document.querySelector('#accountMini')?.click();else document.querySelector(`#${key}`)?.click()}));
}

function render(){
 const myVerBadge=verifyBadgeHtml({isVerified:S.me?.isVerified,status:S.me?.verificationStatus,department:S.me?.department,explanation:S.me?.verificationExplanation},true);
 app.innerHTML=`<div class="workspace"><header><button type="button" class="sidebar-toggle-btn" id="toggleSidebar" aria-label="Thu gọn hoặc mở rộng thanh điều hướng bên" title="Thu gọn / Mở rộng thanh bên">☰</button>${brand()}<div class="searchbox" role="search"><span aria-hidden="true">⌕</span><input id="search" type="search" aria-label="Tìm kiếm thư" value="${esc(S.q)}" placeholder="Tìm trong thư — người gửi, người nhận, tiêu đề..."></div><div class="layout-switcher header-layout-tools" role="group" aria-label="Tùy chọn độ rộng"><button class="layout-btn ${S.layoutWidth==='narrow'?'active':''}" data-set-width="narrow" title="Hẹp (1100px)">Hẹp</button><button class="layout-btn ${S.layoutWidth==='standard'?'active':''}" data-set-width="standard" title="Tiêu chuẩn (1440px)">Chuẩn</button><button class="layout-btn ${S.layoutWidth==='wide'?'active':''}" data-set-width="wide" title="Toàn màn hình / Rộng (96vw)">Rộng</button></div><span id="v4-net" class="v4-net">${navigator.onLine?'● Trực tuyến':'● Mất mạng'}</span><button class="iconbtn" id="notif" type="button" aria-label="Mở thông báo" title="Thông báo">◌</button>${avatar(S.me,'top-avatar')}</header><aside><button class="compose" id="compose">＋ <span>Soạn thư</span></button><div class="v3-section-label">HỘP THƯ</div><nav>${nav('inbox','Hộp thư đến')}${nav('starred','Đánh dấu')}${nav('snoozed','Đã hoãn')}${nav('sent','Đã gửi')}${nav('drafts','Bản nháp')}${nav('archive','Lưu trữ')}${nav('spam','Thư rác')}${nav('trash','Thùng rác')}</nav><button type="button" class="navbtn mobile-more" id="mobileMore" aria-label="Mở thêm thư mục và công cụ" title="Thêm"> <i aria-hidden="true">•••</i><span>Thêm</span></button><div class="aside-sep"></div><button type="button" class="navbtn" id="contacts" aria-label="Danh bạ" title="Danh bạ"><i aria-hidden="true">◎</i><span>Danh bạ</span></button>${['admin','super_admin'].includes(S.me.role)?'<button type="button" class="navbtn" id="admin" aria-label="Quản trị hệ thống" title="Quản trị hệ thống"><i aria-hidden="true">◇</i><span>Quản trị hệ thống</span></button>':''}<div class="aside-system"><span class="live-dot"></span><span>Trung tâm Thư điện tử Sky First</span></div><div class="account-mini" id="accountMini" role="button" tabindex="0" aria-label="Mở hồ sơ tài khoản" title="Tài khoản">${avatar(S.me,'mini-avatar')}<div><b>${esc(S.me.displayName)}${myVerBadge}</b><span>${esc(S.me.email)}</span></div></div><div class="v4-footer"><b>Trung tâm Thư điện tử Sky First</b><span>© 2026 Sky First · mail.skyfirst.io.vn</span></div></aside><section class="list"><div class="listhead"><div class="v3-list-actions"><label class="v3-select-all" title="Chọn tất cả"><input type="checkbox" id="v3all"><span></span></label><button data-bulk="read" title="Đánh dấu đã đọc">✓</button><button data-bulk="star" title="Đánh dấu sao">★</button><button data-bulk="spam" title="Spam">!</button><button data-bulk="trash" title="Thùng rác">⌫</button><span class="v3-selected-count"></span></div><div><h2 id="folderTitle"></h2><p>${esc(S.mailboxes.map(x=>x.address).join(' · '))}</p></div><button class="secondary v4-mini" id="v4-markall" type="button">✓ Đọc tất cả</button><button class="iconbtn" id="reload" type="button" aria-label="Làm mới danh sách thư" title="Làm mới">↻</button></div><div id="rows"></div></section><main id="reader"><div class="empty"><div class="empty-icon">✉</div><h3>Chọn một thư để đọc</h3><p>Chọn một thư trong danh sách để xem nội dung.</p></div></main></div>`;
 document.querySelectorAll('[data-folder]').forEach(b=>b.onclick=async()=>{
  if(b.dataset.folder==='drafts')return draftsModal();
  S.folder=b.dataset.folder;S.selected=null;document.querySelector('.workspace').classList.remove('reading');document.querySelectorAll('.navbtn').forEach(x=>x.classList.remove('active'));b.classList.add('active');await loadMessages();
 });
 document.querySelector('#compose').onclick=()=>typeof window.SkyFirstCompose==='function'?window.SkyFirstCompose():compose();
 document.querySelector('#accountMini').onclick=account;document.querySelector('.top-avatar').onclick=account;
 const activateAccount=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();account()}};
 document.querySelector('#accountMini').addEventListener('keydown',activateAccount);
 document.querySelector('.top-avatar').addEventListener('keydown',activateAccount);
 document.querySelector('#mobileMore').onclick=mobileMore;
 document.querySelector('#contacts')?.addEventListener('click',contacts);
 document.querySelector('#admin')?.addEventListener('click',admin);
 document.querySelector('#notif').onclick=notifications;
 document.querySelector('#reload').onclick=()=>{loadMessages();loadSummary()};document.querySelector('#toggleSidebar')?.addEventListener('click',()=>applySidebarState(S.sidebarState==='collapsed'?'expanded':'collapsed'));document.querySelectorAll('[data-set-width]').forEach(b=>b.addEventListener('click',async()=>{const w=b.dataset.setWidth;applyLayoutWidth(w);try{await api('/api/preferences',{method:'PATCH',body:JSON.stringify({theme:S.theme,density:w,readingPane:'right',undoSendSeconds:S.me.preferences?.undo_send_seconds??10})})}catch{}}));
 document.querySelector('#v4-markall').onclick=async()=>{try{await api('/api/messages/mark-all-read',{method:'POST',body:JSON.stringify({folder:S.folder})});appNotice('Đã đánh dấu tất cả là đã đọc.','success');await loadMessages();loadSummary()}catch(e){appNotice(e.message,'error')}};
 document.querySelector('#v3all').onchange=e=>{
  document.querySelectorAll('.row[data-id]').forEach(r=>{
   const id=Number(r.dataset.id),cb=r.querySelector('.v3-row-check');if(!cb)return;
   cb.checked=e.target.checked;r.classList.toggle('selected',e.target.checked);
   if(e.target.checked)S.selectedIds.add(id);else S.selectedIds.delete(id);
  });
  updateSelectedCount();
 };
 document.querySelectorAll('[data-bulk]').forEach(b=>b.onclick=()=>bulkAction(b.dataset.bulk));
 let timer;document.querySelector('#search').oninput=e=>{clearTimeout(timer);timer=setTimeout(async()=>{S.q=e.target.value.trim();await loadMessages()},350)};
}

function updateSelectedCount(){
 const el=document.querySelector('.v3-selected-count');
 if(el)el.textContent=S.selectedIds.size?`${S.selectedIds.size} đã chọn`:'';
}
async function bulkAction(action){
 const ids=[...S.selectedIds];if(!ids.length)return appNotice('Hãy chọn ít nhất một thư.','info');
 try{await api('/api/messages/bulk',{method:'POST',body:JSON.stringify({ids,action})});S.selectedIds.clear();updateSelectedCount();appNotice('Đã cập nhật thư.','success');await loadMessages();loadSummary()}catch(e){appNotice(e.message,'error')}
}

async function loadMessages(before=null,append=false,requestOptions={}){
 const cursor=before?`&before=${encodeURIComponent(before)}`:'';
 const d=await api(`/api/messages?folder=${encodeURIComponent(S.folder)}&q=${encodeURIComponent(S.q)}${cursor}`,requestOptions);
 S.messages=append?[...S.messages,...(d.messages||[])]:d.messages||[];S.nextCursor=d.nextCursor||null;S.hasMore=!!d.hasMore;
 const title={inbox:'Hộp thư đến',starred:'Đánh dấu',snoozed:'Đã hoãn',sent:'Đã gửi',drafts:'Bản nháp',archive:'Lưu trữ',spam:'Thư rác',trash:'Thùng rác'}[S.folder]||S.folder;
 const titleEl=document.querySelector('#folderTitle');if(titleEl)titleEl.textContent=title;
 const moreButton=document.querySelector('#mobileMore');if(moreButton)moreButton.classList.toggle('active',!['inbox','starred','sent','drafts'].includes(S.folder));
 const rows=document.querySelector('#rows');if(!rows)return;
 rows.innerHTML=S.messages.length?S.messages.map(m=>{
  const badge=S.folder==='sent'?'':verifyBadgeHtml(m.sender_verification,true);
  const recallTag=m.status==='recalled'?'<span class="sf-recalled-pill">Đã thu hồi</span>':m.status==='recall_partial'?'<span class="sf-recalled-pill">Thu hồi một phần</span>':'';
  return`<article class="row ${m.is_read?'':'unread'}" data-id="${m.id}"><label class="v3-row-selector" onclick="event.stopPropagation()"><input class="v3-row-check" type="checkbox" ${S.selectedIds.has(m.id)?'checked':''}><span></span></label><button class="rowstar" data-star="${m.id}" aria-label="Đánh dấu sao">${m.is_starred?'★':'☆'}</button><button class="rowimportance" data-important="${m.id}" aria-label="Đánh dấu quan trọng">${m.is_important?'❗':'·'}</button><div class="rowbody"><div class="rowtop"><b>${esc(S.folder==='sent'?parseRecipients(m.recipients_json):m.sender)}${badge}${recallTag}</b><time>${esc(when(m.received_at||m.sent_at||m.created_at))}</time></div><h4>${esc(m.subject||'(Không có tiêu đề)')}</h4><p>${esc(m.preview||'')}</p></div></article>`;
 }).join(''):`<div class="empty small"><h3>Chưa có thư</h3><p>Không có nội dung phù hợp trong mục này.</p></div>`;
 rows.querySelectorAll('.row').forEach(r=>{
  const id=Number(r.dataset.id),cb=r.querySelector('.v3-row-check');
  cb?.addEventListener('change',()=>{if(cb.checked)S.selectedIds.add(id);else S.selectedIds.delete(id);r.classList.toggle('selected',cb.checked);updateSelectedCount()});
  r.onclick=e=>{if(e.target.closest('.rowstar,.rowimportance,.v3-row-selector'))return;openMessage(id)};
 });
 rows.querySelectorAll('.rowstar').forEach(b=>b.onclick=async e=>{e.stopPropagation();const m=S.messages.find(x=>x.id===Number(b.dataset.star));await api(`/api/messages/${m.id}`,{method:'PATCH',body:JSON.stringify({isStarred:!m.is_starred})});await loadMessages()});
 rows.querySelectorAll('.rowimportance').forEach(b=>b.onclick=async e=>{e.stopPropagation();const m=S.messages.find(x=>x.id===Number(b.dataset.important));await api(`/api/messages/${m.id}`,{method:'PATCH',body:JSON.stringify({isImportant:!m.is_important})});await loadMessages()});
 if(S.hasMore){const b=document.createElement('button');b.className='secondary load-more';b.textContent='Tải thêm thư';b.onclick=async()=>{b.disabled=true;b.textContent='Đang tải…';try{await loadMessages(S.nextCursor,true)}catch(e){b.disabled=false;b.textContent='Thử tải lại';window.SkyFirstDialog.alert(e.message)}};rows.appendChild(b)}
}
const parseRecipients=s=>{try{return JSON.parse(s||'[]').join(', ')}catch{return s||''}};
function prepareMailHtml(html){
 const doc=new DOMParser().parseFromString(String(html||''),'text/html');
 // Defence in depth: received email HTML remains untrusted even after server-side sanitization.
 doc.querySelectorAll('script,iframe,frame,frameset,object,embed,form,input,button,textarea,select,option,meta,base,link,svg,math,video,audio,canvas,template,applet,portal').forEach(el=>el.remove());
 for(const el of doc.querySelectorAll('*')){
  for(const attr of [...el.attributes]){
   const name=attr.name.toLowerCase(),raw=String(attr.value||'');
   if(name==='srcset'){
    const safeSet=raw.split(',').map(candidate=>{const parts=candidate.trim().split(/\s+/);if(!parts[0]||parts.length>2)return '';const url=parts[0],descriptor=parts[1]||'';const normalized=url.replace(/[\u0000-\u0020\u007f]+/g,'').toLowerCase();if(!/^(?:https?:\/\/|\/)/i.test(normalized))return '';if(descriptor&&!/^(?:\d+w|\d+(?:\.\d+)?x)$/i.test(descriptor))return '';return `${url}${descriptor?' '+descriptor:''}`}).filter(Boolean).join(', ');
    if(safeSet)el.setAttribute('srcset',safeSet);else el.removeAttribute('srcset');continue;
   }
   if(name.startsWith('on')||['srcdoc','formaction','action','xlink:href','xmlns'].includes(name)){el.removeAttribute(attr.name);continue;}
   if(name==='style'&&/(?:url\s*\(|@import|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding)/i.test(raw)){el.removeAttribute(attr.name);continue;}
   if(['href','src','poster','background'].includes(name)){
    const compact=raw.replace(/[\u0000-\u0020\u007f]+/g,'').toLowerCase();
    if(/^(?:javascript|vbscript|file|filesystem):/.test(compact)||/^data:(?!image\/(?:png|gif|jpe?g|webp);base64,)/i.test(compact)||/^blob:/i.test(compact)){el.removeAttribute(attr.name);continue;}
    if(name==='poster'){el.removeAttribute(attr.name);continue;}
    if(name==='background'&&!/^(?:https?:\/\/|\/)/i.test(compact)){el.removeAttribute(attr.name);continue;}
   }
  }
 }
 // CSS blocks can fetch tracking resources independently of <img>, so reject active/external URL rules.
 doc.querySelectorAll('style').forEach(style=>{if(/@import|url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding/i.test(style.textContent||''))style.remove();});
 doc.querySelectorAll('a[href]').forEach(a=>{const raw=(a.getAttribute('href')||'').trim();let u;const base=location.origin&&location.origin!=='null'?location.origin:'https://mail.invalid';try{u=new URL(raw,base)}catch{a.removeAttribute('href');return}if(!['http:','https:','mailto:','tel:'].includes(u.protocol)){a.removeAttribute('href');return}a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer nofollow')});
 doc.querySelectorAll('img[src]').forEach(img=>{const src=(img.getAttribute('src')||'').trim();if(src&&!/^(?:https?:\/\/|\/|#|data:image\/(?:png|gif|jpe?g|webp);base64,)/i.test(src)){img.removeAttribute('src')}});
 return{html:doc.body.innerHTML}
}
async function openMessage(id){
 const d=await api(`/api/messages/${id}`),m=d.message,p=m.parsed||{};S.selected=m;
 document.querySelector('.workspace').classList.add('reading');
 const atts=(p.attachments||[]).map(a=>`<a class="attachment" href="/api/messages/${m.id}/attachments/${a.index}"><b>${esc(a.filename)}</b><span>${esc(a.mimeType)} · ${fmt(a.size)}</span></a>`).join('');
 const verHtml=verifyBadgeHtml(m.sender_verification,false);
 const canRecall=m.direction==='outbound'&&m.status!=='recalled';
 const trashTools=S.folder==='trash'?`<button id="restoreBtn">↶ Khôi phục</button><button id="permDeleteBtn" class="v4-danger">⌫ Xóa vĩnh viễn</button>`:'';
 const recallBanner=m.recall?`<div class="notice ${m.recall.overall_status==='recalled'?'ok':'warn'}" style="margin:10px 0"><b>Trạng thái thu hồi thư:</b> ${m.recall.overall_status==='recalled'?'Đã thu hồi toàn bộ bản thư nội bộ':m.recall.overall_status==='partial'?'Thu hồi một phần (chỉ thu hồi được người nhận nội bộ)':m.recall.overall_status==='cannot_recall'?'Không thể thu hồi (người nhận ở máy chủ bên ngoài)':'Đang xử lý'} · Thu hồi: ${m.recall.recalled_count}/${m.recall.total_recipients} người nhận.</div>`:'';
 document.querySelector('#reader').innerHTML=`<article class="message" data-message-id="${m.id}"><div class="toolbar"><button id="back">←</button><button id="star">${m.is_starred?'★':'☆'} Đánh dấu</button><button id="spamBtn">Thư rác</button><button id="trashBtn">Xóa</button><button id="archiveBtn">Lưu trữ</button><button id="snoozeBtn">${S.folder==='snoozed'?'Bỏ hoãn':'Hoãn 1 giờ'}</button><button id="importantBtn">${m.is_important?'Bỏ quan trọng':'Quan trọng'}</button><button id="prooflineBtn">Bằng chứng</button>${canRecall?`<button id="recallBtn" class="secondary">⤺ Thu hồi email</button>`:''}${trashTools}</div><h1>${esc(p.subject||m.subject||'(Không có tiêu đề)')}</h1>${recallBanner}<div class="senderline"><div class="mail-avatar">${esc(initials(m.sender))}</div><div><b>${esc(m.sender)}${verHtml}</b><span>đến ${esc(parseRecipients(m.recipients_json))}</span><span>${esc(when(m.received_at||m.sent_at||m.created_at))}</span></div></div>${p.html?`<iframe id="mailframe" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" referrerpolicy="no-referrer"></iframe>`:`<div class="textmail">${esc(p.text||'').replace(/\n/g,'<br>')}</div>`}${atts?`<div class="attachments"><h3>Tệp đính kèm</h3>${atts}</div>`:''}<div class="replybar"><button class="secondary" id="reply">↩ Trả lời</button><button class="secondary" id="forward">→ Chuyển tiếp</button></div></article>`;
 if(p.html){const mailFrame=document.querySelector('#mailframe');const renderMailFrame=()=>{const content=prepareMailHtml(p.html).html;const imagePolicy="'self' data: http: https:";mailFrame.srcdoc=`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imagePolicy}; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font-family:Arial,sans-serif;padding:18px;line-height:1.6;color:#172033;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>${content}`};renderMailFrame()}
 document.querySelector('#back').onclick=()=>document.querySelector('.workspace').classList.remove('reading');
 document.querySelector('#star').onclick=async()=>{await api(`/api/messages/${id}`,{method:'PATCH',body:JSON.stringify({isStarred:!m.is_starred})});await loadMessages();await openMessage(id)};
 document.querySelector('#trashBtn').onclick=()=>move(id,'trash');
 document.querySelector('#spamBtn').onclick=()=>move(id,'spam');
 document.querySelector('#archiveBtn').onclick=()=>move(id,'archive');
 document.querySelector('#restoreBtn')?.addEventListener('click',()=>move(id,'inbox'));
 document.querySelector('#permDeleteBtn')?.addEventListener('click',async()=>{if(!await window.SkyFirstDialog.confirm('Xóa vĩnh viễn thư này? Thao tác không thể hoàn tác.'))return;try{await api(`/api/messages/${id}`,{method:'DELETE'});appNotice('Đã xóa vĩnh viễn.','success');document.querySelector('.workspace').classList.remove('reading');await loadMessages()}catch(e){appNotice(e.message,'error')}});
 document.querySelector('#recallBtn')?.addEventListener('click',async()=>{
  const reason=await window.SkyFirstDialog.prompt('Nhập lý do thu hồi email (chỉ thu hồi được bản thư nội bộ Sky First Mail; thư đã gửi ra Gmail/Outlook bên ngoài sẽ giữ nguyên lịch sử):','Gửi nhầm nội dung / người nhận');
  if(reason===null)return;
  try{
   const res=await api(`/api/messages/${id}/recall`,{method:'POST',body:JSON.stringify({reason})});
   modal(`<h2>Kết quả thu hồi email</h2><p class="muted">${esc(res.disclaimer)}</p><div class="settings">${(res.outcomes||[]).map(o=>`<div class="recall-outcome-row"><div><b>${esc(o.recipient)}</b><br><small>${esc(o.detail)}</small></div><span class="pill ${o.status==='recalled'?'ok':''}">${o.status==='recalled'?'Đã thu hồi nội bộ':o.status==='cannot_recall_external'?'Ngoài hệ thống (Không thể thu hồi)':'Không còn bản thư'}</span></div>`).join('')}</div>`,true);
   await loadMessages();await openMessage(id);
  }catch(e){appNotice(e.message,'error')}
 });
 document.querySelector('#snoozeBtn').onclick=async()=>{const snoozedUntil=S.folder==='snoozed'?null:new Date(Date.now()+60*60*1000).toISOString();await api(`/api/messages/${id}`,{method:'PATCH',body:JSON.stringify({snoozedUntil})});document.querySelector('.workspace').classList.remove('reading');await loadMessages()};
 document.querySelector('#importantBtn').onclick=async()=>{await api(`/api/messages/${id}`,{method:'PATCH',body:JSON.stringify({isImportant:!m.is_important})});await loadMessages();await openMessage(id)};
 document.querySelector('#prooflineBtn').onclick=async()=>{const btn=document.querySelector('#prooflineBtn');btn.disabled=true;try{const d=await api(`/api/messages/${id}/proofline`),g=d.integrity||{},state=g.matches===true?'Khớp với mốc đã lưu':g.matches===false?'CẢNH BẠO: dữ liệu khác mốc đã lưu':'Chưa có mốc lịch sử để đối chiếu';const w=modal(`<h2>Sky Proofline</h2><p class="muted">Hồ sơ truy nguyên thư #${esc(d.message?.id)}. Hash kiểm tra dữ liệu MIME đang lưu, không tự chứng minh danh tính người gửi hoặc giá trị pháp lý.</p><div class="settings"><h3>${esc(state)}</h3><label>SHA-256 hiện tại<input id="prooflineHash" readonly value="${esc(g.currentHash||'')}"></label><p><b>Nguồn mốc:</b> ${esc(g.baselineSource||'Chưa rõ')}</p><p><b>Ghi nhận lúc:</b> ${esc(g.baselineRecordedAt||'Chưa có mốc')}</p><p><b>Người gửi:</b> ${esc(d.message?.sender||'')}</p><p><b>Tiêu đề:</b> ${esc(d.message?.subject||'(Không có tiêu đề)')}</p><p><b>Message-ID:</b> ${esc(d.message?.messageId||'Không có')}</p><p><b>Kích thước MIME:</b> ${esc(fmt(d.message?.rawSize||0))}</p><p><b>Trạng thái gửi:</b> ${esc(d.delivery?.operationStatus||'Không có')}</p><p><b>Mã nhà cung cấp:</b> ${esc(d.delivery?.providerMessageId||'Không có')}</p><button class="primary" id="prooflineCopy">Sao chép SHA-256</button><div id="prooflineMsg"></div></div>`,true);w.querySelector('#prooflineCopy').onclick=async()=>{try{await navigator.clipboard.writeText(g.currentHash||'');w.querySelector('#prooflineMsg').textContent='Đã sao chép hash.'}catch{const x=w.querySelector('#prooflineHash');x.select();w.querySelector('#prooflineMsg').textContent='Hãy sao chép giá trị đang được chọn.'}}}catch(e){window.SkyFirstDialog.alert(e.message)}finally{const current=document.querySelector('#prooflineBtn');if(current)current.disabled=false}};
 document.querySelector('#reply').onclick=()=>typeof window.SkyFirstCompose==='function'?window.SkyFirstCompose({mode:'reply',to:m.sender,subject:`Re: ${p.subject||m.subject||''}`,replyToMessageId:m.id}):compose({to:m.sender,subject:`Re: ${p.subject||m.subject||''}`});
 document.querySelector('#forward').onclick=()=>typeof window.SkyFirstCompose==='function'?window.SkyFirstCompose({mode:'forward',subject:`Fwd: ${p.subject||m.subject||''}`,text:`\n\n---------- Forwarded message ----------\nFrom: ${m.sender}\nSubject: ${p.subject||m.subject||''}\n\n${p.text||''}`}):compose({subject:`Fwd: ${p.subject||m.subject||''}`,text:`\n\n---------- Forwarded message ----------\nFrom: ${m.sender}\nSubject: ${p.subject||m.subject||''}\n\n${p.text||''}`});
}
async function move(id,folder){await api(`/api/messages/${id}`,{method:'PATCH',body:JSON.stringify({folder})});document.querySelector('.workspace').classList.remove('reading');await loadMessages()}
function compose(seed={}){const mb=S.mailboxes.find(x=>x.is_primary)||S.mailboxes[0];const w=modal(`<div class="compose-head"><div><h2>Tin nhắn mới</h2><p>Gửi thư đến người nhận trong và ngoài hệ thống</p></div></div><form id="cf"><div class="inline-field"><label>Từ</label><select name="mailboxId">${S.mailboxes.filter(x=>x.is_active).map(x=>`<option value="${x.id}" ${x.id===mb?.id?'selected':''}>${esc(x.address)}</option>`).join('')}</select></div><div class="inline-field"><label>Đến</label><input name="to" value="${esc(seed.to||'')}" placeholder="user@domain.com" required></div><div class="inline-field"><label>Cc</label><input name="cc"></div><input class="subject-input" name="subject" value="${esc(seed.subject||'')}" placeholder="Tiêu đề"><textarea name="text" rows="12" placeholder="Viết nội dung...">${esc(seed.text||'')}</textarea><div class="compose-foot"><label class="attach">＋ Đính kèm<input name="attachments" type="file" multiple hidden></label><button class="primary">Gửi</button></div><div id="cm"></div></form>`,true);w.querySelector('#cf').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const files=e.currentTarget.querySelector('[name=attachments]').files;fd.delete('attachments');for(const f of files)fd.append('attachments',f);try{await api('/api/compose',{method:'POST',body:fd});w.remove();S.folder='sent';render();await loadMessages()}catch(x){w.querySelector('#cm').innerHTML=msg(x.message)}}}

async function account(){
 const verPill=S.me.isVerified?`<span class="sf-verified-badge">✓ Đã xác minh tích xanh</span>`:`<span class="pill">Chưa cấp tích xanh</span>`;
 const w=modal(`<div class="account-hero">${avatar(S.me,'profile-avatar')}<div><h2>${esc(S.me.displayName)} ${verPill}</h2><p>${esc(S.me.email)} ${S.me.department?'· '+esc(S.me.department):''}</p><span class="pill">${esc(roleLabel(S.me.role))} · ${esc(accountTypeLabel(S.me.accountType))}</span></div><div class="v4-account-actions"><button class="secondary" id="v4-usage">Dung lượng</button><button class="v4-danger" id="v4-logout">Đăng xuất</button></div></div><div class="tabs"><button class="active" data-tab="profile">Hồ sơ</button><button data-tab="security">Bảo mật</button><button data-tab="mail">Thư điện tử</button><button data-tab="appearance">Giao diện</button></div><div id="tab"></div>`,true);
 w.querySelector('#v4-logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
 w.querySelector('#v4-usage').onclick=async()=>{const u=await api('/api/mailbox/usage');appNotice(`${u.messageCount} thư · ${fmt(u.messageBytes)} / ${fmt(u.quotaBytes)} hạn mức`,'info')};
 const box=w.querySelector('#tab');
 const open=async name=>{
  w.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  if(name==='profile'){
   box.innerHTML=`<div class="profile-layout"><section class="profile-main-card"><div class="profile-title"><span>Hồ sơ Sky First</span><small>${esc(S.me.verificationExplanation||'Thông tin hiển thị trong Danh bạ và thư điện tử.')}</small></div><label>Tên hiển thị<input id="pn" value="${esc(S.me.displayName)}" ${S.me.allowNameChange?'':'disabled'}></label>${S.me.allowNameChange?'<button class="primary" id="saveName">Lưu tên hiển thị</button>':'<p class="hint">Tên được quản lý bởi quản trị viên.</p>'}<label>Trạng thái<select id="ps"><option value="available">Sẵn sàng</option><option value="busy">Đang bận</option><option value="away">Tạm vắng</option><option value="offline">Ẩn trạng thái</option></select></label><button class="secondary" id="saveStatus">Cập nhật trạng thái</button><div class="profile-meta"><div><span>Email đăng nhập</span><b>${esc(S.me.email)}</b></div><div><span>Trạng thái xác minh</span><b>${S.me.isVerified?'✓ Đã xác minh tích xanh':'Chưa xác minh (Chỉ Quản trị viên có quyền cấp)'}</b></div></div></section><section class="avatar-card"><div class="avatar-preview-wrap" id="avatarPreview">${avatar(S.me,'profile-avatar xl')}</div><h3>Ảnh đại diện</h3><p>PNG/JPG/WebP, tối đa 5 MB. Ảnh đại diện này hiển thị nội bộ trong Sky First Mail.</p>${S.me.allowAvatarChange?'<label class="dropzone" for="af"><b>Chọn ảnh mới</b><span>Kéo thả hoặc nhấn để chọn</span><input id="af" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><div class="avatar-actions"><button class="primary" id="saveAvatar" disabled>Lưu ảnh đại diện</button><button class="secondary danger-soft" id="removeAvatar">Xóa ảnh</button></div><div id="avatarMsg"></div>':'<p class="hint">Ảnh đại diện được quản trị viên quản lý.</p>'}</section></div>`;
   box.querySelector('#ps').value=S.me.profileStatus||'available';
   box.querySelector('#saveName')?.addEventListener('click',async()=>{try{await api('/api/profile/name',{method:'PATCH',body:JSON.stringify({displayName:box.querySelector('#pn').value})});location.reload()}catch(e){appNotice(e.message,'error')}});
   box.querySelector('#saveStatus').onclick=async()=>{await api('/api/profile/status',{method:'PATCH',body:JSON.stringify({status:box.querySelector('#ps').value})});S.me.profileStatus=box.querySelector('#ps').value;box.querySelector('#avatarMsg')&&(box.querySelector('#avatarMsg').innerHTML=msg('Đã cập nhật trạng thái.','ok'))};
   const af=box.querySelector('#af'),save=box.querySelector('#saveAvatar');
   af?.addEventListener('change',()=>{const f=af.files?.[0];if(!f)return;if(f.size>5*1024*1024){box.querySelector('#avatarMsg').innerHTML=msg('Ảnh vượt quá 5 MB.');af.value='';save.disabled=true;return}const url=URL.createObjectURL(f);box.querySelector('#avatarPreview').innerHTML=`<img class="profile-avatar xl" src="${url}" alt="Xem trước">`;save.disabled=false});
   save?.addEventListener('click',async()=>{const f=af.files?.[0];if(!f)return;save.disabled=true;save.textContent='Đang tải lên...';try{const fd=new FormData();fd.append('avatar',f,f.name);const d=await api('/api/profile/avatar',{method:'POST',body:fd});S.me.avatarKey=d.key;box.querySelector('#avatarMsg').innerHTML=msg('Đã đổi ảnh đại diện.','ok');setTimeout(()=>location.reload(),500)}catch(e){box.querySelector('#avatarMsg').innerHTML=msg(e.message);save.disabled=false;save.textContent='Lưu ảnh đại diện'}});
   box.querySelector('#removeAvatar')?.addEventListener('click',async()=>{try{await api('/api/profile/avatar',{method:'DELETE'});S.me.avatarKey=null;box.querySelector('#avatarMsg').innerHTML=msg('Đã xóa ảnh đại diện.','ok');setTimeout(()=>location.reload(),400)}catch(e){box.querySelector('#avatarMsg').innerHTML=msg(e.message)}});
  }
  if(name==='security'){
   const ss=await api('/api/sessions');
   box.innerHTML=`<section class="settings"><h3>Đổi mật khẩu</h3>${S.me.allowPasswordChange?'<div class="grid2"><label>Mật khẩu hiện tại<input id="cp" type="password"></label><label>Mật khẩu mới<input id="np" type="password"></label></div><button class="primary" id="pw">Đổi mật khẩu</button>':'<p class="hint">Mật khẩu do Admin quản lý.</p>'}<h3>Phiên đăng nhập <button class="secondary" id="killOthers" type="button" style="margin-left:10px">Đăng xuất thiết bị khác</button></h3>${ss.sessions.map(s=>`<div class="session"><div><b>${s.id===ss.currentSessionId?'Thiết bị hiện tại':'Phiên đăng nhập'}</b><span>${esc(s.ip||'')} · ${esc((s.user_agent||'').slice(0,90))}</span><span>${esc(when(s.last_seen_at||s.created_at))}</span></div>${s.id===ss.currentSessionId?'':`<button data-kill="${s.id}" class="dangerbtn">Đăng xuất</button>`}</div>`).join('')}</section>`;
   box.querySelector('#pw')?.addEventListener('click',async()=>{try{await api('/api/profile/password',{method:'PATCH',body:JSON.stringify({currentPassword:box.querySelector('#cp').value,newPassword:box.querySelector('#np').value})});window.SkyFirstDialog.notice('Đã đổi mật khẩu.','success')}catch(e){window.SkyFirstDialog.alert(e.message)}});
   box.querySelector('#killOthers')?.addEventListener('click',async()=>{await api('/api/sessions/others',{method:'DELETE'});open('security')});
   box.querySelectorAll('[data-kill]').forEach(b=>b.onclick=async()=>{await api(`/api/sessions/${b.dataset.kill}`,{method:'DELETE'});open('security')});
  }
  if(name==='mail'){
   const [sg,rl]=await Promise.all([api('/api/signatures'),api('/api/rules')]);
   const curUndo=Number(S.me.preferences?.undo_send_seconds??10);
   box.innerHTML=`<section class="settings"><h3>Hoàn tác gửi (Undo Send)</h3><label>Thời gian giữ thư trước khi chuyển đi<select id="undoSec">${[0,5,10,20,30].map(sec=>`<option value="${sec}" ${curUndo===sec?'selected':''}>${sec===0?'Tắt (chuyển đi ngay)':`${sec} giây`}</option>`).join('')}</select></label><button class="secondary" id="saveUndoPref">Lưu cài đặt hoàn tác</button><h3 style="margin-top:24px">Chữ ký email</h3>${sg.signatures.map(x=>`<div class="account-row"><div><b>${esc(x.name)}</b><span>${x.is_default?'Mặc định':''}</span></div></div>`).join('')||'<p class="hint">Chưa có chữ ký.</p>'}${S.me.allowSignatureChange?`<div class="grid2"><label>Tên chữ ký<input id="sn" placeholder="Cá nhân"></label><label>Hộp thư<select id="smb"><option value="">Tất cả</option>${S.mailboxes.map(m=>`<option value="${m.id}">${esc(m.address)}</option>`).join('')}</select></label></div><label>Nội dung<textarea id="sc" rows="5" placeholder="Trân trọng,..."></textarea></label><label><input id="sd" type="checkbox" style="width:auto"> Đặt làm mặc định</label><button class="primary" id="adds">Thêm chữ ký</button>`:'<p class="hint">Chữ ký do Admin quản lý.</p>'}<h3 style="margin-top:28px">Quy tắc thư đến</h3>${rl.rules.map(x=>`<div class="account-row"><div><b>${esc(x.name)}</b><span>${x.sender_contains?'Người gửi chứa: '+esc(x.sender_contains)+' · ':''}${x.subject_contains?'Tiêu đề chứa: '+esc(x.subject_contains)+' · ':''}${x.action_folder?'→ '+esc(x.action_folder):''}${x.action_star?' · Star':''}</span></div></div>`).join('')||'<p class="hint">Chưa có quy tắc.</p>'}<div class="grid2"><label>Tên quy tắc<input id="rn" placeholder="Mail tuyển dụng"></label><label>Hộp thư<select id="rmb"><option value="">Tất cả</option>${S.mailboxes.map(m=>`<option value="${m.id}">${esc(m.address)}</option>`).join('')}</select></label><label>Người gửi chứa<input id="rs" placeholder="@example.com"></label><label>Tiêu đề chứa<input id="rsub" placeholder="Đăng ký"></label><label>Chuyển vào<select id="rf"><option value="">Giữ Inbox</option><option value="spam">Thư rác</option><option value="trash">Trash</option></select></label><label><input id="rst" type="checkbox" style="width:auto"> Tự đánh dấu sao</label></div><button class="secondary" id="addr">Thêm quy tắc</button></section>`;
   box.querySelector('#saveUndoPref').onclick=async()=>{const sec=Number(box.querySelector('#undoSec').value);await api('/api/preferences',{method:'PATCH',body:JSON.stringify({theme:S.theme,density:'comfortable',readingPane:'right',undoSendSeconds:sec})});if(S.me.preferences)S.me.preferences.undo_send_seconds=sec;appNotice('Đã lưu thời gian hoàn tác gửi.','success')};
   box.querySelector('#adds')?.addEventListener('click',async()=>{await api('/api/signatures',{method:'POST',body:JSON.stringify({name:box.querySelector('#sn').value,contentHtml:box.querySelector('#sc').value.replace(/\n/g,'<br>'),mailboxId:box.querySelector('#smb').value||null,isDefault:box.querySelector('#sd').checked})});open('mail')});
   box.querySelector('#addr').onclick=async()=>{await api('/api/rules',{method:'POST',body:JSON.stringify({name:box.querySelector('#rn').value,mailboxId:box.querySelector('#rmb').value||null,senderContains:box.querySelector('#rs').value,subjectContains:box.querySelector('#rsub').value,actionFolder:box.querySelector('#rf').value,actionStar:box.querySelector('#rst').checked})});open('mail')};
  }
  if(name==='appearance'){
   box.innerHTML=`<section class="settings">
    <h3>Chủ đề màu sắc</h3>
    <div class="theme-cards">${['system','light','dark','sky'].map(t=>`<button data-theme="${t}" class="theme-card ${S.theme===t?'active':''}">${{system:'Theo hệ thống',light:'Sáng',dark:'Tối',sky:'Sky Blue'}[t]}</button>`).join('')}</div>
    <h3 style="margin-top:24px">Độ rộng nội dung hiển thị (Bố cục)</h3>
    <div class="theme-cards">
      <button data-layout-choice="narrow" class="theme-card ${S.layoutWidth==='narrow'?'active':''}"><b>Hẹp (1100px)</b><br><small class="muted">Tập trung đọc thư</small></button>
      <button data-layout-choice="standard" class="theme-card ${S.layoutWidth==='standard'?'active':''}"><b>Tiêu chuẩn (1440px)</b><br><small class="muted">Cân đối mặc định</small></button>
      <button data-layout-choice="wide" class="theme-card ${S.layoutWidth==='wide'?'active':''}"><b>Rộng (Toàn màn hình)</b><br><small class="muted">Tối đa diện tích</small></button>
    </div>
    <h3 style="margin-top:24px">Thanh điều hướng bên (Sidebar)</h3>
    <div class="theme-cards" style="grid-template-columns:1fr 1fr">
      <button data-sidebar-mode="expanded" class="theme-card ${S.sidebarState==='expanded'?'active':''}"><b>Mở rộng</b><br><small class="muted">Đầy đủ nhãn thư mục</small></button>
      <button data-sidebar-mode="collapsed" class="theme-card ${S.sidebarState==='collapsed'?'active':''}"><b>Thu gọn</b><br><small class="muted">Chỉ hiển thị biểu tượng</small></button>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
      <div><b>Khôi phục mặc định</b><br><small class="muted">Đặt lại độ rộng tiêu chuẩn và mở rộng thanh bên</small></div>
      <button class="secondary" id="resetLayoutBtn" type="button">Khôi phục bố cục</button>
    </div>
   </section>`;
   box.querySelectorAll('[data-theme]').forEach(b=>b.onclick=async()=>{try{await api('/api/preferences',{method:'PATCH',body:JSON.stringify({theme:b.dataset.theme,density:S.layoutWidth||'standard',readingPane:'right',undoSendSeconds:S.me.preferences?.undo_send_seconds??10})});applyTheme(b.dataset.theme);open('appearance')}catch(e){window.SkyFirstDialog.alert(e.message)}});
   box.querySelectorAll('[data-layout-choice]').forEach(b=>b.onclick=async()=>{try{applyLayoutWidth(b.dataset.layoutChoice);await api('/api/preferences',{method:'PATCH',body:JSON.stringify({theme:S.theme,density:b.dataset.layoutChoice,readingPane:'right',undoSendSeconds:S.me.preferences?.undo_send_seconds??10})});open('appearance')}catch(e){window.SkyFirstDialog.alert(e.message)}});
   box.querySelectorAll('[data-sidebar-mode]').forEach(b=>b.onclick=()=>{applySidebarState(b.dataset.sidebarMode);open('appearance')});
   box.querySelector('#resetLayoutBtn').onclick=()=>{resetLayoutDefaults();open('appearance')};
  }
 };
 w.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>open(b.dataset.tab));open('profile');
}

async function contacts(){let d={people:[]},c={contacts:[]};if(['admin','super_admin'].includes(S.me.role)){try{d=await api('/api/directory')}catch{}}try{c=await api('/api/contacts')}catch(e){window.SkyFirstDialog.alert(e.message);return}const w=modal(`<h2>Danh bạ</h2><p class="muted">Liên hệ cá nhân của bạn${d.people.length?' và danh sách tài khoản nội bộ được phép xem':''}.</p>${d.people.length?`<h3>Tài khoản nội bộ</h3><div class="directory">${d.people.map(p=>`<div class="person">${p.avatar_key?`<img src="/api/avatar/${p.id}" class="mini-avatar">`:`<div class="mini-avatar">${esc(initials(p.display_name))}</div>`}<div><b>${esc(p.display_name)}${p.is_verified?'<span class="sf-verified-badge icon-only" title="Tài khoản đã xác minh">✓</span>':''}</b><span>${esc(p.email)}${p.department?' · '+esc(p.department):''}</span></div><button class="secondary" data-mail="${esc(p.email)}">Soạn thư</button></div>`).join('')}</div><hr>`:''}<h3>Liên hệ đã lưu</h3><div class="grid2"><label>Tên<input id="cn"></label><label>Email<input id="ce" type="email"></label></div><label>Ghi chú<input id="cnotes" placeholder="Tuỳ chọn"></label><button class="primary" id="addc">Thêm liên hệ</button><div class="directory">${c.contacts.map(x=>`<div class="person"><div class="mini-avatar">${esc(initials(x.display_name||x.email))}</div><div><b>${esc(x.display_name||x.email)}</b><span>${esc(x.email)}</span>${x.notes?`<small>${esc(x.notes)}</small>`:''}</div><button class="secondary" data-mail="${esc(x.email)}">Soạn thư</button><button class="danger" data-contact-delete="${x.id}">Xóa</button></div>`).join('')||'<p class="muted">Chưa có liên hệ cá nhân.</p>'}</div><div id="contactMsg"></div>`,true);w.querySelectorAll('[data-mail]').forEach(b=>b.onclick=()=>{w.remove();typeof window.SkyFirstCompose==='function'?window.SkyFirstCompose({to:b.dataset.mail}):compose({to:b.dataset.mail})});w.querySelector('#addc').onclick=async()=>{try{await api('/api/contacts',{method:'POST',body:JSON.stringify({displayName:w.querySelector('#cn').value,email:w.querySelector('#ce').value,notes:w.querySelector('#cnotes').value})});w.remove();contacts()}catch(e){w.querySelector('#contactMsg').innerHTML=msg(e.message)}};w.querySelectorAll('[data-contact-delete]').forEach(b=>b.onclick=async()=>{if(!await window.SkyFirstDialog.confirm('Xóa liên hệ này?'))return;try{await api(`/api/contacts/${b.dataset.contactDelete}`,{method:'DELETE'});b.closest('.person').remove()}catch(e){w.querySelector('#contactMsg').innerHTML=msg(e.message)}})}
async function notifications(){const d=await api('/api/notifications');const w=modal(`<h2>Thông báo</h2><div class="notif-list">${d.notifications.length?d.notifications.map(n=>`<button class="notif ${n.is_read?'':'new'}" data-id="${n.id}"><b>${esc(n.title)}</b><span>${esc(n.body||'')}</span><time>${esc(when(n.created_at))}</time></button>`).join(''):'<p class="muted">Chưa có thông báo.</p>'}</div>`);w.querySelectorAll('.notif').forEach(b=>b.onclick=async()=>{await api(`/api/notifications/${b.dataset.id}/read`,{method:'POST'});b.classList.remove('new');loadSummary()})}

async function admin(){
 const appRoot=document.querySelector('#app');
 appRoot.innerHTML=`<main id="adminWorkspace" class="admin-workspace"><header class="admin-topbar"><div class="admin-brand"><img src="/sky-first-logo.png" alt="Sky First"><div><span>SKY FIRST MAIL · MAIL.SKYFIRST.IO.VN</span><b>Trung tâm quản trị</b></div></div><div class="admin-top-actions"><div class="layout-switcher" role="group" aria-label="Tùy chọn độ rộng"><button class="layout-btn ${S.layoutWidth==='narrow'?'active':''}" data-set-width="narrow" title="Hẹp (1100px)">Hẹp</button><button class="layout-btn ${S.layoutWidth==='standard'?'active':''}" data-set-width="standard" title="Tiêu chuẩn (1440px)">Chuẩn</button><button class="layout-btn ${S.layoutWidth==='wide'?'active':''}" data-set-width="wide" title="Rộng (Toàn màn hình)">Rộng</button></div><span class="admin-signed-in">${esc(S.me.displayName||S.me.email)} · ${esc(roleLabel(S.me.role))}</span><button class="secondary" id="leaveAdmin" type="button">← Quay lại hộp thư</button></div></header><section class="admin-content"><div class="admin-page-heading"><div><span class="admin-kicker">QUẢN TRỊ HỆ THỐNG</span><h1>Trung tâm Thư điện tử Sky First</h1><p>Quản lý tài khoản, tích xanh xác minh, ủy quyền gửi thay, tên miền BIMI/DNS, hàng đợi chống spam và nhật ký bảo mật.</p></div><button class="primary" id="newu" type="button">＋ Tạo tài khoản</button></div><div class="stats" id="adminStats"><div><b>—</b><span>Tài khoản</span></div><div><b>—</b><span>Hộp thư</span></div><div><b>—</b><span>Thư</span></div><div><b>—</b><span>Dữ liệu thư</span></div><div><b>—</b><span>Chưa đọc</span></div></div><nav class="admin-tabs" aria-label="Các mục quản trị"><button class="active" data-a="users" type="button">Tài khoản</button><button data-a="verifications" type="button">Huy hiệu xác minh</button><button data-a="reports" type="button">Tố cáo an ninh</button><button data-a="delegations" type="button">Ủy quyền gửi thay</button><button data-a="aliases" type="button">Bí danh</button><button data-a="domains" type="button">Tên miền & BIMI</button><button data-a="antispam" type="button">Chống spam & Hàng đợi</button><button data-a="system" type="button">Hệ thống & Bảo mật</button><button data-a="audit" type="button">Nhật ký</button></nav><div id="adminError" class="notice error" role="status" aria-live="polite" hidden></div><div id="adminbody"><div class="admin-loading"><span class="login-spinner"></span> Đang tải dữ liệu quản trị…</div></div></section></main>`;
 const root=document.querySelector('#adminWorkspace');
 const body=root.querySelector('#adminbody');
 root.querySelector('#leaveAdmin').onclick=async()=>{render();try{await loadMessages();loadSummary()}catch(e){const rows=document.querySelector('#rows');if(rows)rows.innerHTML=msg(`Không tải được hộp thư: ${e.message}`)}};
 let dash,users,aliases,domains,audit,system,activeTab='users';
 const setError=(message)=>{const el=root.querySelector('#adminError');el.hidden=!message;el.textContent=message||''};
 const refresh=async()=>{
  setError('');
  try{
     [dash,users,domains]=await Promise.all([
       api('/api/admin/dashboard'),
       api('/api/admin/users'),
       domains||api('/api/admin/domains')
     ]);
   }
  catch(e){body.innerHTML=`<section class="admin-error-panel"><h2>Chưa tải được dữ liệu quản trị</h2><p></p><button class="primary" id="retryAdmin">Thử tải lại</button></section>`;body.querySelector('p').textContent=`${e.message}${e.status?` (HTTP ${e.status})`:''}`;body.querySelector('#retryAdmin').onclick=refresh;setError('Một hoặc nhiều dịch vụ quản trị không phản hồi. Chi tiết được hiển thị bên dưới.');return false}
  const st=dash.stats;root.querySelector('#adminStats').innerHTML=`<div><b>${st.users}</b><span>Tài khoản (${st.verifiedUsers||0} tích xanh)</span></div><div><b>${st.activeMailboxes}</b><span>Hộp thư hoạt động</span></div><div><b>${st.messages}</b><span>Thư (${st.queuedMessages||0} hàng đợi)</span></div><div><b>${fmt(st.bytes)}</b><span>Dữ liệu thư</span></div><div><b>${st.unread}</b><span>Chưa đọc (${st.openSecurityAlerts||0} cảnh báo)</span></div>`;
  root.querySelector('#newu').onclick=()=>newUser(root,domains.domains);
  await open(activeTab);return true;
 };
 const refreshDomains=async()=>{domains=await api('/api/admin/domains');await open('domains')};
 const domainChecks={};
 const renderDomainCheck=d=>{
   const isOfficial=['skyfirst.io.vn','mail.skyfirst.io.vn'].includes(d.domain.toLowerCase());
   if(isOfficial){
     return `<div class="domain-verification"><div class="domain-verification-status"><b style="color:#087848">✓ Đã xác minh chính thức</b> · <b>Tên miền hệ thống Sky First Network</b> (Sẵn sàng gửi & nhận thư)</div><div class="bimi-matrix"><div class="bimi-chip ok"><b>MX Nhận thư</b>Đã có (Cloudflare)</div><div class="bimi-chip ok"><b>SPF Gửi thư</b>Hợp lệ</div><div class="bimi-chip ok"><b>DKIM Chữ ký</b>Đã cấu hình</div><div class="bimi-chip ok"><b>DMARC</b>Đã cấu hình</div></div><div class="domain-actions"><button class="secondary" data-domain-health="${d.id}" type="button">Kiểm tra kết nối DNS</button></div></div>`;
   }
  const result=domainChecks[d.id]||(d.health_json?{health:JSON.parse(d.health_json)}:null);
  const h=result?.health||null;
  const record=result?.requiredRecord||(d.verification_token?{type:'TXT',name:`_skyfirst-mail.${d.domain}`,value:`skyfirst-mail-verification=${d.verification_token}`}:null);
  const status=result?.message||(d.status==='verified'?'Quyền sở hữu đã xác minh':d.status==='disabled'?'Tên miền bị vô hiệu hóa':'Chưa xác minh quyền sở hữu');
  return `<div class="domain-verification"><div class="domain-verification-status"><b>Trạng thái:</b> ${esc(status)} · <b>Xác minh bên ngoài (Gmail/BIMI):</b> ${esc(h?.externalLabel||d.external_verification_status||'Chưa kiểm tra')}</div>${record?`<div class="dns-record"><span>TXT · Tên bản ghi</span><code>${esc(record.name)}</code><span>Giá trị</span><code>${esc(record.value)}</code></div>`:`<p class="muted">Cần tạo mã xác minh TXT trước khi gửi thư.</p>`}${h?`<div class="bimi-matrix"><div class="bimi-chip ${h.mx?'ok':'warn'}"><b>MX Nhận thư</b>${h.mx?'Đã có':'Chưa thấy'}</div><div class="bimi-chip ${h.spf?.ok?'ok':'warn'}"><b>SPF</b>${h.spf?.ok?'Hợp lệ':'Thiếu / Chưa chuẩn'}</div><div class="bimi-chip ${h.dkim?.ok?'ok':'warn'}"><b>DKIM (${esc(h.dkim?.selector||'resend')})</b>${h.dkim?.ok?'Đã cấu hình':'Chưa thấy'}</div><div class="bimi-chip ${h.dmarc?.bimiEligible?'ok':'warn'}"><b>DMARC</b>${h.dmarc?.ok?`p=${esc(h.dmarc.policy)} (${h.dmarc.bimiEligible?'Đạt BIMI':'Cần quarantine/reject'})`:'Chưa có'}</div><div class="bimi-chip ${h.bimi?.logoValid?'ok':'warn'}"><b>BIMI Logo SVG</b>${h.bimi?.logoValid?'Hợp lệ':'Chưa cấu hình'}</div><div class="bimi-chip ${h.bimi?.vmcConfigured?'ok':'warn'}"><b>Chứng thư VMC</b>${h.bimi?.vmcConfigured?'Đã khai báo':'Chưa có VMC (Gmail cần)'}</div></div>`:''}<div class="domain-actions"><button class="secondary" data-domain-verify="${d.id}" type="button">${record?'Kiểm tra TXT & BIMI':'Tạo bản ghi TXT'}</button><button class="secondary" data-domain-health="${d.id}" type="button">Kiểm tra DNS</button></div>${h?`<small>TXT: ${h.ownership?'khớp':'chưa khớp'} · MX: ${h.mx?'đã có':'chưa thấy'}</small>`:''}${h?.remediation?.length?`<ul style="margin:10px 0 0;padding-left:18px;font-size:12px;color:#52799e">${h.remediation.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}</div>`;
 };
 async function open(name){
  activeTab=name;root.querySelectorAll('.admin-tabs [data-a]').forEach(b=>b.classList.toggle('active',b.dataset.a===name));setError('');
  if(name==='users'){
   body.innerHTML=`<div class="bulk-toolbar"><label class="bulk-check"><input type="checkbox" id="selectAllUsers"> Chọn tất cả tài khoản</label><button class="secondary" id="bulkCreateUsers" type="button">＋ Tạo hàng loạt</button><button class="dangerbtn" id="bulkDeleteUsers" type="button">Xóa đã chọn</button><span id="bulkStatus" role="status" aria-live="polite"></span></div><div class="account-list">${users.users.map(u=>`<div class="account-row"><input type="checkbox" class="user-select" data-user-select="${u.id}" ${Number(u.id)===Number(S.me.id)?'disabled title="Không thể chọn tài khoản đang đăng nhập"':''}><div class="mini-avatar">${esc(initials(u.display_name))}</div><div class="account-identity"><b>${esc(u.display_name)}${u.is_verified&&u.verification_status==='verified'?'<span class="sf-verified-badge icon-only" title="Đã xác minh tích xanh">✓</span>':''}</b><span>${esc(u.email)} ${u.department?'· '+esc(u.department):''}</span></div><span class="pill">${esc(roleLabel(u.role))} · ${esc(accountTypeLabel(u.account_type))}</span><span class="pill ${u.status==='active'?'ok':''}">${esc(statusLabel(u.status))}</span><button class="secondary" data-edit="${u.id}" type="button">Sửa</button></div>`).join('')||'<p class="empty-admin">Chưa có tài khoản.</p>'}</div>`;
   body.querySelector('#selectAllUsers').onchange=e=>body.querySelectorAll('.user-select:not(:disabled)').forEach(c=>c.checked=e.target.checked);
   body.querySelector('#bulkCreateUsers').onclick=()=>bulkCreateUsers(root,domains.domains);
    body.querySelector('#bulkDeleteUsers').onclick=async()=>{
     const checkedBoxes=[...body.querySelectorAll('.user-select:checked')];
     const ids=checkedBoxes.map(c=>Number(c.dataset.userSelect));const status=body.querySelector('#bulkStatus');
     if(!ids.length){status.textContent='Hãy chọn ít nhất một tài khoản.';return}
     if(!await inlineConfirm(root,`Xóa vĩnh viễn ${ids.length} tài khoản đã chọn cùng hộp thư và dữ liệu liên quan?`))return;
     const btn=body.querySelector('#bulkDeleteUsers');btn.disabled=true;btn.textContent='Đang xóa…';let ok=0,failed=[];
     for(const id of ids){
       const uRow=users?.users?.find(x=>Number(x.id)===id);
       try{
         const result=await api(`/api/admin/users/${id}`,{method:'DELETE',body:JSON.stringify({confirm:true,confirmEmail:uRow?.email})});
         if(!result.deleted)throw new Error(result.error||'Máy chủ chưa xác nhận xóa thành công.');
         ok++;
         body.querySelectorAll(`.account-row input[data-user-select="${id}"]`).forEach(c=>c.closest('.account-row')?.remove());
       }catch(e){failed.push(`${uRow?.email||id}: ${apiErrorText(e)}`)}
     }
     if(users?.users){
       users.users=users.users.filter(x=>!ids.includes(Number(x.id)));
       const countEl=root.querySelector('#adminStats b');if(countEl)countEl.textContent=String(users.users.length);
     }
     status.textContent=`Xóa thành công ${ok}/${ids.length} tài khoản.`+(failed.length?` Còn lỗi: ${failed.join(' · ')}`:'');
     btn.disabled=false;btn.textContent='Xóa đã chọn';
     if(failed.length)appNotice(`Đã xóa ${ok}/${ids.length}. Các tài khoản còn lỗi: ${failed.join(' · ')}`,'error');
     else appNotice(`Đã xóa thành công ${ok} tài khoản.`,'success');
    };
   body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const user=users.users.find(x=>Number(x.id)===Number(b.dataset.edit));if(user)editUser(user,root)});
  }else if(name==='verifications'){
   const vData=await api('/api/admin/verifications');
   const badgeFilterHtml = `<div class="bulk-toolbar" style="margin-bottom:14px;gap:8px">
     <input id="verSearch" placeholder="Tìm tài khoản theo email hoặc tên..." style="max-width:320px">
     <select id="badgeFilter" style="max-width:220px;height:42px;border:1.5px solid #bddcf6;border-radius:10px;padding:0 10px;font-size:13px">
       <option value="all">Tất cả tài khoản (${vData.accounts.length})</option>
       <option value="personal">Tích xanh — Cá nhân (${vData.accounts.filter(x=>x.account_type==='personal'&&x.is_verified).length})</option>
       <option value="organization">Tích vàng — Tổ chức (${vData.accounts.filter(x=>x.account_type==='organization'&&x.is_verified).length})</option>
       <option value="service">Tích tím — Dịch vụ (${vData.accounts.filter(x=>x.account_type==='service'&&x.is_verified).length})</option>
       <option value="unverified">Chưa cấp huy hiệu (${vData.unverifiedAccounts.length})</option>
     </select>
     <span class="muted" style="margin-left:auto">${vData.verifiedAccounts.length} đã cấp huy hiệu · ${vData.unverifiedAccounts.length} chưa cấp</span>
   </div>`;
   body.innerHTML=`<div class="domain-head"><div><h2>QUẢN LÝ HUY HIỆU XÁC MINH (Sky First Verified)</h2><p>Quản lý tập trung 3 loại huy hiệu: Tích xanh (Cá nhân), Tích vàng (Tổ chức/Doanh nghiệp) và Tích tím (Dịch vụ hệ thống). Tất cả tài khoản trong hệ thống mặc định đã xác minh thuộc Sky First.</p></div><a href="/verified" target="_blank" class="secondary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:9px 14px">🌐 Cổng tra cứu công khai ↗</a></div>${badgeFilterHtml}<div class="account-list" id="verList">${vData.accounts.map(u=>{
     const isVer = u.is_verified && u.verification_status==='verified';
     const badgeClass = isVer ? (u.account_type==='organization'?'sf-verified-badge gold':u.account_type==='service'?'sf-verified-badge service':'sf-verified-badge') : '';
     const badgeText = isVer ? (u.account_type==='organization'?'✓ Tích vàng Tổ chức':u.account_type==='service'?'✓ Tích tím Dịch vụ':'✓ Tích xanh Cá nhân') : `<span class="pill">${esc(u.verification_status||'unverified')}</span>`;
     return `<div class="account-row ver-row" data-ver-email="${esc(u.email.toLowerCase())}" data-ver-type="${esc(u.account_type||'personal')}" data-ver-status="${isVer?'verified':'unverified'}"><div class="ver-identity-group"><div class="mini-avatar">${esc(initials(u.display_name))}</div><div class="account-identity"><b>${esc(u.display_name)} ${isVer?`<span class="${badgeClass}">${badgeText}</span>`:badgeText}</b><span>${esc(u.email)} · Loại: <b>${esc(accountTypeLabel(u.account_type))}</b> · Hệ thống: <span style="color:#087848;font-weight:700">Đã xác minh</span>${u.department?' · Đơn vị: '+esc(u.department):''}${u.verification_reason?' · Lý do: '+esc(u.verification_reason):''}</span></div></div><div class="ver-actions" style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" data-ver-grant="${u.id}" type="button">${isVer?'Đổi huy hiệu':'Cấp huy hiệu'}</button>${u.verification_status==='suspended'?`<button class="secondary" data-ver-restore="${u.id}" type="button">Khôi phục</button>`:''}${isVer?`<button class="secondary" data-ver-suspend="${u.id}" type="button">Tạm dừng</button><button class="dangerbtn" data-ver-revoke="${u.id}" type="button">Thu hồi</button>`:''}</div></div>`;
   }).join('')}</div><h3 style="margin-top:28px">Lịch sử cấp và thay đổi huy hiệu</h3><div>${vData.history.map(h=>`<div class="audit"><b>${esc(h.action.toUpperCase())} · ${esc(h.user_email)} (${esc(h.previous_status)} → ${esc(h.new_status)})</b><span>Loại: ${esc(h.account_type||'personal')} · Người thực hiện: ${esc(h.actor_name||h.actor_email||'Admin')} · Lý do: ${esc(h.reason)}</span><time>${esc(when(h.created_at))}</time></div>`).join('')||'<p class="muted">Chưa có lịch sử thay đổi huy hiệu.</p>'}</div>`;

   const filterRows = ()=>{
     const q = body.querySelector('#verSearch').value.trim().toLowerCase();
     const type = body.querySelector('#badgeFilter').value;
     body.querySelectorAll('#verList .ver-row').forEach(r=>{
       const matchQ = !q || r.dataset.verEmail.includes(q);
       const matchType = type === 'all' || (type === 'unverified' ? r.dataset.verStatus === 'unverified' : (r.dataset.verType === type && r.dataset.verStatus === 'verified'));
       r.hidden = !(matchQ && matchType);
     });
   };
   body.querySelector('#verSearch').oninput = filterRows;
   body.querySelector('#badgeFilter').onchange = filterRows;

   body.querySelectorAll('[data-ver-grant]').forEach(b=>b.onclick=async()=>{
    const target=vData.accounts.find(x=>x.id===Number(b.dataset.verGrant));if(!target)return;
    const w=modal(`<h2>Cấp / Thay đổi Huy hiệu Xác minh</h2><p class="muted">${esc(target.display_name)} (${esc(target.email)})</p><label>Loại huy hiệu xác minh<select id="vt"><option value="personal" ${target.account_type==='personal'?'selected':''}>Tích xanh — Xác minh danh tính cá nhân</option><option value="organization" ${target.account_type==='organization'?'selected':''}>Tích vàng — Tổ chức, doanh nghiệp, cơ quan đối tác</option><option value="service" ${target.account_type==='service'?'selected':''}>Tích tím — Dịch vụ hệ thống, thông báo tự động</option><option value="delegated" ${target.account_type==='delegated'?'selected':''}>Danh tính ủy quyền</option></select></label><label>Đơn vị / Phòng ban phụ trách<input id="vd" value="${esc(target.department||'Trung tâm Thư điện tử Sky First')}"></label><label>Lý do và căn cứ cấp huy hiệu (bắt buộc)<input id="vr" value="Đã thẩm định hồ sơ danh tính và quyền sử dụng tên miền Sky First"></label><div id="vm"></div><button class="primary" id="vgo" type="button">Xác nhận cấp huy hiệu</button>`);
    w.classList.add('admin-dialog-wrap');
    w.querySelector('#vgo').onclick=async()=>{try{await api(`/api/admin/users/${target.id}/verify`,{method:'POST',body:JSON.stringify({action:'grant',accountType:w.querySelector('#vt').value,department:w.querySelector('#vd').value,reason:w.querySelector('#vr').value})});w.remove();appNotice(`Đã cấp huy hiệu xác minh cho ${target.email}.`,'success');await refresh();open('verifications')}catch(e){w.querySelector('#vm').innerHTML=msg(e.message)}};
   });
   body.querySelectorAll('[data-ver-suspend]').forEach(b=>b.onclick=async()=>{
    const reason=await uiPrompt('Nhập lý do tạm đình chỉ huy hiệu xác minh:','Tạm đình chỉ để rà soát lại thông tin định danh');if(!reason)return;
    try{await api(`/api/admin/users/${b.dataset.verSuspend}/verify`,{method:'POST',body:JSON.stringify({action:'suspend',reason})});appNotice('Đã tạm đình chỉ huy hiệu.','success');await refresh();open('verifications')}catch(e){appNotice(e.message,'error')}
   });
   body.querySelectorAll('[data-ver-restore]').forEach(b=>b.onclick=async()=>{
    try{await api(`/api/admin/users/${b.dataset.verRestore}/verify`,{method:'POST',body:JSON.stringify({action:'restore',reason:'Khôi phục huy hiệu xác minh sau khi đối soát đạt tiêu chuẩn'})});appNotice('Đã khôi phục huy hiệu xác minh.','success');await refresh();open('verifications')}catch(e){appNotice(e.message,'error')}
   });
   body.querySelectorAll('[data-ver-revoke]').forEach(b=>b.onclick=async()=>{
    const reason=await uiPrompt('Nhập lý do thu hồi huy hiệu xác minh:','Thu hồi theo rà soát định kỳ / thay đổi phân công nhiệm vụ');if(!reason)return;
    try{await api(`/api/admin/users/${b.dataset.verRevoke}/verify`,{method:'POST',body:JSON.stringify({action:'revoke',reason})});appNotice('Đã thu hồi huy hiệu xác minh.','success');await refresh();open('verifications')}catch(e){appNotice(e.message,'error')}
   });
  }else if(name==='reports'){
   const rptData=await api('/api/admin/brand-reports');
   body.innerHTML=`<div class="domain-head"><div><h2>Hộp thư Tiếp nhận Tố cáo An ninh Thương hiệu</h2><p>Tiếp nhận, đối soát và xử lý các vụ việc mạo danh, email lừa đảo, giả mạo nhân sự hoặc vi phạm thương hiệu Sky First.</p></div></div><div class="bulk-toolbar" style="margin-bottom:16px"><span class="muted">${rptData.reports.length} hồ sơ tố cáo đã tiếp nhận</span></div><div class="account-list">${rptData.reports.map(r=>{
     const pillClass = r.status==='Đã xác minh vi phạm'?'danger':r.status==='Đã xử lý'?'ok':r.status==='Đang xác minh'?'warning':'';
     return `<div class="account-row report-row" style="grid-template-columns:minmax(200px,1fr) auto auto"><div class="account-identity"><b>[${esc(r.receiptCode)}] ${esc(r.reportedEmail)} · <span class="pill ${pillClass}">${esc(r.status)}</span></b><span>Loại: <b>${esc(r.reportType)}</b> · ${esc(when(r.createdAt))} ${r.incidentTime?'· Thời điểm: '+esc(r.incidentTime):''}</span><p style="margin:6px 0 0;font-size:13px;color:#2c5270;line-height:1.5">${esc(r.description)}</p>${r.reporterEmail?`<small style="color:#577e9f">Người gửi: ${esc(r.reporterName||'Ẩn danh')} (${esc(r.reporterEmail)})</small>`:''}${r.evidenceNotes?`<div style="font-size:12px;color:#6b7280;margin-top:4px">Bằng chứng: ${esc(r.evidenceNotes)}</div>`:''}${r.adminNotes?`<div style="font-size:12px;color:#0369a1;background:#f0f9ff;padding:6px 10px;border-radius:6px;margin-top:6px"><b>Ghi chú xử lý:</b> ${esc(r.adminNotes)} (${esc(r.resolvedByName||'Admin')})</div>`:''}</div><button class="secondary" data-update-report="${r.id}" type="button">Xử lý hồ sơ</button></div>`;
   }).join('')||'<p class="empty-admin">Chưa có hồ sơ tố cáo an ninh nào.</p>'}</div>`;

   body.querySelectorAll('[data-update-report]').forEach(b=>b.onclick=()=>{
     const r = rptData.reports.find(x=>x.id===Number(b.dataset.updateReport)); if(!r) return;
     const w = modal(`<h2>Xử lý Hồ sơ Tố cáo [${esc(r.receiptCode)}]</h2><p class="muted">Email bị tố cáo: <b>${esc(r.reportedEmail)}</b> (${esc(r.reportType)})</p><label>Trạng thái giải quyết<select id="rptNewStatus"><option value="Mới tiếp nhận" ${r.status==='Mới tiếp nhận'?'selected':''}>Mới tiếp nhận</option><option value="Đang xác minh" ${r.status==='Đang xác minh'?'selected':''}>Đang xác minh</option><option value="Cần bổ sung bằng chứng" ${r.status==='Cần bổ sung bằng chứng'?'selected':''}>Cần bổ sung bằng chứng</option><option value="Đã xác minh vi phạm" ${r.status==='Đã xác minh vi phạm'?'selected':''}>Đã xác minh vi phạm</option><option value="Không đủ căn cứ" ${r.status==='Không đủ căn cứ'?'selected':''}>Không đủ căn cứ</option><option value="Đã xử lý" ${r.status==='Đã xử lý'?'selected':''}>Đã xử lý</option></select></label><label>Ghi chú kết quả xử lý<textarea id="rptAdminNotes" rows="3" placeholder="Nhập kết luận kiểm tra, phương án chặn hoặc biên bản xử lý...">${esc(r.adminNotes||'')}</textarea></label><div id="rptModalMsg"></div><div class="account-actions"><button class="primary" id="saveRptBtn">Lưu kết quả xử lý</button><button class="secondary" id="closeRptBtn">Hủy</button></div>`);
     w.classList.add('admin-dialog-wrap');
     w.querySelector('#closeRptBtn').onclick=()=>w.remove();
     w.querySelector('#saveRptBtn').onclick=async()=>{
       try{
         await api(`/api/admin/brand-reports/${r.id}`,{
           method:'PATCH',
           body:JSON.stringify({
             status: w.querySelector('#rptNewStatus').value,
             adminNotes: w.querySelector('#rptAdminNotes').value.trim()
           })
         });
         w.remove();
         appNotice(`Đã cập nhật hồ sơ ${r.receiptCode}.`,'success');
         open('reports');
       }catch(err){
         w.querySelector('#rptModalMsg').innerHTML=msg(err.message);
       }
     };
   });
}else if(name==='delegations'){
   const delData=await api('/api/admin/delegations');
   body.innerHTML=`<div class="domain-head"><div><h2>Ủy quyền gửi thay (Send-As Delegation)</h2><p>Cho phép tài khoản được chỉ định gửi thư dưới danh tính địa chỉ khác (ví dụ: hoptac@skyfirst.io.vn) mà không cấp quyền đọc hộp thư đến của địa chỉ đó.</p></div><button class="primary" id="newDelegation" type="button">＋ Cấp quyền gửi thay</button></div><div class="account-list">${delData.delegations.map(d=>`<div class="account-row delegation-row"><div class="account-identity"><b>${esc(d.grantee_name)} (${esc(d.grantee_email)}) → được gửi từ ${esc(d.allowed_address)}</b><span>Chế độ: ${d.permission_mode==='send_on_behalf'?'Gửi thay mặt (Send on Behalf)':'Gửi dưới danh tính (Send As)'} · Mục đích: ${esc(d.purpose||'Công việc')}</span></div><button class="dangerbtn" data-revoke-del="${d.id}" type="button">Thu hồi quyền</button></div>`).join('')||'<p class="empty-admin">Chưa có ủy quyền gửi thay nào.</p>'}</div>`;
   body.querySelector('#newDelegation').onclick=()=>{
    const w=modal(`<h2>Cấp quyền gửi thay địa chỉ khác</h2><label>Hộp thư nguồn (địa chỉ hiển thị khi gửi)<select id="delMb">${users.users.filter(u=>u.primary_mailbox_id).map(u=>`<option value="${u.primary_mailbox_id}" data-addr="${esc(u.email)}">${esc(u.email)} — ${esc(u.display_name)}</option>`).join('')}</select></label><label>Tài khoản được cấp quyền thực hiện gửi<select id="delGrantee">${users.users.map(u=>`<option value="${u.id}">${esc(u.email)} — ${esc(u.display_name)}</option>`).join('')}</select></label><label>Chế độ hiển thị<select id="delMode"><option value="send_as">Gửi dưới danh tính trực tiếp (Send As)</option><option value="send_on_behalf">Gửi thay mặt có ghi nhận Sender (Send on Behalf)</option></select></label><label>Mục đích cấp quyền<input id="delPurpose" value="Phối hợp đối ngoại / xử lý công việc"></label><div id="delMsg"></div><button class="primary" id="saveDel" type="button">Cấp quyền gửi thay</button>`);
    w.classList.add('admin-dialog-wrap');
    w.querySelector('#saveDel').onclick=async()=>{
     const selMb=w.querySelector('#delMb');const addr=selMb.options[selMb.selectedIndex]?.dataset?.addr||'';
     try{await api('/api/admin/delegations',{method:'POST',body:JSON.stringify({mailboxId:Number(selMb.value),granteeUserId:Number(w.querySelector('#delGrantee').value),allowedAddress:addr,permissionMode:w.querySelector('#delMode').value,purpose:w.querySelector('#delPurpose').value})});w.remove();appNotice('Đã cấp quyền gửi thay thành công.','success');open('delegations')}catch(e){w.querySelector('#delMsg').innerHTML=msg(e.message)}
    };
   };
   body.querySelectorAll('[data-revoke-del]').forEach(b=>b.onclick=async()=>{if(!await inlineConfirm(root,'Thu hồi quyền gửi thay này?'))return;await api(`/api/admin/delegations/${b.dataset.revokeDel}`,{method:'DELETE'});open('delegations')});
  }else if(name==='aliases'){
   if(!aliases)aliases=await api('/api/admin/aliases');
   body.innerHTML=`<div class="domain-head"><div><h2>Bí danh thư</h2><p>Địa chỉ phụ được chuyển đến hộp thư đích.</p></div><button class="primary" id="newAlias" type="button">＋ Tạo bí danh</button></div>${aliases.aliases.map(a=>`<div class="account-row alias-row"><div class="account-identity"><b>${esc(a.address)}</b><span>→ ${esc(a.mailbox_address)} · ${esc(a.display_name)}</span></div><button class="dangerbtn" data-delete-alias="${a.id}" type="button">Xóa</button></div>`).join('')||'<p class="empty-admin">Chưa có bí danh.</p>'}`;
   body.querySelector('#newAlias').onclick=()=>newAlias(root,users.users);
   body.querySelectorAll('[data-delete-alias]').forEach(b=>b.onclick=async()=>{if(!await inlineConfirm(root,'Xóa bí danh này?'))return;b.disabled=true;try{await api(`/api/admin/aliases/${b.dataset.deleteAlias}`,{method:'DELETE'});aliases=await api('/api/admin/aliases');await open('aliases')}catch(e){setError(`Không xóa được bí danh: ${e.message}`);b.disabled=false}});
   }else if(name==='domains'){
    body.innerHTML=`<div class="domain-head"><div><h2>Quản lý Tên miền Chính & Tên miền Phụ</h2><p>Thêm, cấu hình, tạm ngưng, khôi phục và xóa tên miền an toàn. Hỗ trợ đầy đủ tên miền chính (skyfirst.io.vn) và các tên miền phụ (app.skyfirst.io.vn, notify.skyfirst.io.vn...).</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><a href="/verified?domain=skyfirst.io.vn" target="_blank" class="secondary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:9px 14px">🌐 Tra cứu chứng thư ↗</a><button class="primary" id="newDomain" type="button">＋ Thêm tên miền</button></div></div><div class="bulk-toolbar" style="margin-bottom:18px"><input id="domainSearch" placeholder="Tìm theo tên miền hoặc tên miền phụ..." style="max-width:360px"><span class="muted">${domains.domains.length} tên miền đang quản lý</span></div><div class="domain-grid" id="domainGrid">${domains.domains.map(d=>`<article class="domain-card" data-domain-card="${d.id}" data-domain-name="${esc(d.domain.toLowerCase())}"><div class="domain-icon">@</div><div class="domain-info"><b>${esc(d.domain)}</b><span>${d.receive_enabled?'Nhận thư đang bật':'Nhận thư đang tắt'} · ${d.send_enabled?'Gửi thư đang bật':'Gửi thư đang tắt'} · ${d.status==='disabled'?'Đã tạm khóa':['skyfirst.io.vn','mail.skyfirst.io.vn'].includes(d.domain.toLowerCase())?'Đã xác minh':esc(d.status||'chưa xác minh')}</span></div><div class="domain-switches"><label class="switch-row">Nhận <input type="checkbox" data-domain-receive="${d.id}" ${d.receive_enabled?'checked':''}></label><label class="switch-row">Gửi <input type="checkbox" data-domain-send="${d.id}" ${d.send_enabled?'checked':''} ${d.status==='verified'||['skyfirst.io.vn','mail.skyfirst.io.vn'].includes(d.domain.toLowerCase())?'':'disabled'}></label></div>${renderDomainCheck(d)}<div class="domain-mgmt-actions" style="margin-top:14px;padding-top:12px;border-top:1px solid #dbe9f6;display:flex;gap:8px;flex-wrap:wrap"><button class="secondary" data-domain-edit="${d.id}" type="button">⚙ Cấu hình</button><button class="secondary" data-domain-toggle-status="${d.id}" type="button">${d.status==='disabled'?'▶ Kích hoạt':'⏸ Tạm khóa'}</button>${['skyfirst.io.vn','mail.skyfirst.io.vn'].includes(d.domain.toLowerCase())?'':`<button class="dangerbtn" data-domain-del="${d.id}" type="button">🗑 Xóa tên miền</button>`}</div></article>`).join('')||'<p class="empty-admin">Chưa có tên miền.</p>'}</div>`;
    body.querySelector('#domainSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();body.querySelectorAll('#domainGrid .domain-card').forEach(card=>{card.hidden=q&&!card.dataset.domainName.includes(q)})};
    body.querySelector('#newDomain').onclick=()=>newDomain(root,refreshDomains);
    body.querySelectorAll('[data-domain-receive]').forEach(c=>c.onchange=async()=>{c.disabled=true;try{await api(`/api/admin/domains/${c.dataset.domainReceive}`,{method:'PATCH',body:JSON.stringify({receiveEnabled:c.checked})});domains=await api('/api/admin/domains');await open('domains')}catch(e){c.checked=!c.checked;setError(`Không cập nhật được trạng thái nhận thư: ${e.message}`);c.disabled=false}});
    body.querySelectorAll('[data-domain-send]').forEach(c=>c.onchange=async()=>{c.disabled=true;try{await api(`/api/admin/domains/${c.dataset.domainSend}`,{method:'PATCH',body:JSON.stringify({sendEnabled:c.checked})});domains=await api('/api/admin/domains');await open('domains')}catch(e){c.checked=!c.checked;setError(`Không cập nhật được trạng thái gửi thư: ${e.message}`);c.disabled=false}});
    body.querySelectorAll('[data-domain-verify]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{domainChecks[b.dataset.domainVerify]=await api(`/api/admin/domains/${b.dataset.domainVerify}/verify`,{method:'POST'});domains=await api('/api/admin/domains')}catch(e){domainChecks[b.dataset.domainVerify]={message:e.message}}await open('domains')});
    body.querySelectorAll('[data-domain-health]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{domainChecks[b.dataset.domainHealth]=await api(`/api/admin/domains/${b.dataset.domainHealth}/health`)}catch(e){domainChecks[b.dataset.domainHealth]={message:e.message}}await open('domains')});
    body.querySelectorAll('[data-domain-edit]').forEach(b=>b.onclick=()=>{
     const d=domains.domains.find(x=>x.id===Number(b.dataset.domainEdit));if(!d)return;
     const w=modal(`<h2>Cấu hình tên miền: ${esc(d.domain)}</h2><label>Hạ tầng gửi thư (Transport)<select id="edTransport"><option value="resend" ${d.transport==='resend'?'selected':''}>Resend API</option><option value="gateway" ${d.transport==='gateway'?'selected':''}>SMTP / MTA Gateway</option></select></label><label>DKIM Selector<input id="edDkim" value="${esc(d.dkim_selector||'resend')}"></label><label>Giới hạn gửi/ngày<input id="edLimit" type="number" value="${d.daily_send_limit||2000}"></label><label>URL Logo BIMI SVG<input id="edBimi" value="${esc(d.bimi_logo_url||'https://mail.skyfirst.io.vn/bimi-logo.svg')}"></label><label>URL Chứng thư VMC (nếu có)<input id="edVmc" value="${esc(d.bimi_vmc_url||'')}"></label><div id="edMsg"></div><div class="account-actions"><button class="primary" id="saveDomCfg">Lưu cấu hình</button><button class="secondary" id="closeDomCfg">Hủy</button></div>`);
     w.classList.add('admin-dialog-wrap');
     w.querySelector('#closeDomCfg').onclick=()=>w.remove();
     w.querySelector('#saveDomCfg').onclick=async()=>{
       try{
         await api(`/api/admin/domains/${d.id}`,{method:'PATCH',body:JSON.stringify({transport:w.querySelector('#edTransport').value,dkimSelector:w.querySelector('#edDkim').value.trim(),dailySendLimit:Number(w.querySelector('#edLimit').value)||2000,bimiLogoUrl:w.querySelector('#edBimi').value.trim(),bimiVmcUrl:w.querySelector('#edVmc').value.trim()})});
         w.remove();appNotice(`Đã lưu cấu hình tên miền ${d.domain}.`,'success');refreshDomains();
       }catch(e){w.querySelector('#edMsg').innerHTML=msg(e.message)}
     };
    });
    body.querySelectorAll('[data-domain-toggle-status]').forEach(b=>b.onclick=async()=>{
     const d=domains.domains.find(x=>x.id===Number(b.dataset.domainToggleStatus));if(!d)return;
     const newDisabled=d.status!=='disabled';
     if(newDisabled&&!await inlineConfirm(root,`Tạm ngưng tên miền ${d.domain}? Hộp thư thuộc tên miền này sẽ tạm thời ngừng gửi và nhận thư.`))return;
     try{
       await api(`/api/admin/domains/${d.id}`,{method:'PATCH',body:JSON.stringify({receiveEnabled:!newDisabled,sendEnabled:!newDisabled})});
       appNotice(`Đã ${newDisabled?'tạm khóa':'kích hoạt lại'} tên miền ${d.domain}.`,'success');
       refreshDomains();
     }catch(e){appNotice(e.message,'error')}
    });
    body.querySelectorAll('[data-domain-del]').forEach(b=>b.onclick=async()=>{
     const d=domains.domains.find(x=>x.id===Number(b.dataset.domainDel));if(!d)return;
     if(!await inlineConfirm(root,`Xóa tên miền ${d.domain} khỏi hệ thống? Thao tác này sẽ kiểm tra các hộp thư phụ thuộc trước khi thực hiện.`))return;
     b.disabled=true;
     try{
       const res=await api(`/api/admin/domains/${d.id}`,{method:'DELETE'});
       if(res.removed){
         body.querySelector(`article[data-domain-card="${d.id}"]`)?.remove();
         domains.domains=domains.domains.filter(x=>x.id!==d.id);
         appNotice(`Đã xóa vĩnh viễn tên miền ${d.domain}.`,'success');
       }else if(res.disabledOnly){
         appNotice(res.message||'Tên miền có tài khoản phụ thuộc nên đã được chuyển sang chế độ tạm khóa an toàn.','info');
         refreshDomains();
       }
     }catch(e){appNotice(`Không thể xóa tên miền: ${e.message}`,'error');b.disabled=false}
    });
  }else if(name==='antispam'){
   const [rep,qData,supps]=await Promise.all([api('/api/admin/reputation'),api('/api/admin/queue'),api('/api/admin/suppressions')]);
   const m=rep.metrics||{},pol=rep.policy||{};
   body.innerHTML=`<div class="domain-head"><div><h2>Giám sát Uy tín, Chống Spam, Hàng đợi & Danh sách chặn</h2><p>${esc(rep.dataSourceNote||'')}</p></div></div><div class="stats"><div><b>${m.totalSent||0}</b><span>Thư đã gửi</span></div><div><b>${m.waitingInQueue||0}</b><span>Đang chờ hàng đợi</span></div><div><b>${m.providerAccepted||0}</b><span>Nhà cung cấp nhận</span></div><div><b>${m.bounced||0} (${m.bounceRatePct||0}%)</b><span>Thư bị trả lại</span></div><div><b>${m.spamComplaints||0} (${m.complaintRatePct||0}%)</b><span>Báo cáo Spam</span></div></div><div class="admin-subgrid"><section class="admin-panel-card"><h3>Chính sách giới hạn tốc độ & Rủi ro</h3><div class="grid2"><label>Tối đa người nhận/thư<input id="spMaxRcpt" type="number" value="${pol.maxRecipientsPerMessage||50}"></label><label>Giới hạn gửi/giờ<input id="spHour" type="number" value="${pol.defaultHourlyLimit||50}"></label><label>Giới hạn gửi/ngày<input id="spDay" type="number" value="${pol.defaultDailyLimit||200}"></label><label>Tài khoản mới (/giờ)<input id="spNew" type="number" value="${pol.newAccountHourlyLimit||20}"></label></div><button class="primary" id="saveSpamPolicy" type="button" style="margin-top:10px">Lưu chính sách chống spam</button></section><section class="admin-panel-card"><h3>Danh sách chặn & Ngừng nhận thư (${supps.suppressions.length})</h3><div class="grid2"><label>Địa chỉ email<input id="suppEmail" type="email" placeholder="spam@example.com"></label><label>Lý do<select id="suppReason"><option value="manual_block">Chặn thủ công</option><option value="hard_bounce">Trả lại vĩnh viễn (Bounce)</option><option value="unsubscribe">Đã hủy đăng ký</option><option value="complaint">Khiếu nại Spam</option></select></label></div><button class="secondary" id="addSupp" type="button" style="margin-top:10px">＋ Thêm vào danh sách chặn</button><div style="max-height:180px;overflow-y:auto;margin-top:12px">${supps.suppressions.map(s=>`<div class="audit"><b>${esc(s.email)}</b><span>${esc(s.reason)} · ${esc(s.notes||'')}</span><button class="dangerbtn" data-del-supp="${s.id}" type="button">Gỡ</button></div>`).join('')||'<p class="muted">Danh sách chặn đang trống.</p>'}</div></section></div><h3 style="margin-top:24px">Hàng đợi gửi thư (${qData.queue.length})</h3><div>${qData.queue.map(q=>`<div class="account-row"><div class="account-identity"><b>${esc(q.subject||'(Không có tiêu đề)')} · <span class="pill">${esc(q.status)}</span></b><span>Từ: ${esc(q.sender_address)} → ${esc(q.recipients_json)} · Rủi ro: ${q.risk_score}/100 ${q.last_error?'· Lỗi: '+esc(q.last_error):''}</span></div>${['undo_window','scheduled','queued','paused','failed_temporary'].includes(q.status)?`<button class="secondary" data-q-act="flush" data-q-id="${q.id}" type="button">Gửi ngay</button><button class="dangerbtn" data-q-act="cancel" data-q-id="${q.id}" type="button">Hủy</button>`:''}</div>`).join('')||'<p class="muted">Không có thư đang chờ trong hàng đợi.</p>'}</div>`;
   body.querySelector('#saveSpamPolicy').onclick=async()=>{await api('/api/admin/spam-policy',{method:'PUT',body:JSON.stringify({maxRecipientsPerMessage:Number(body.querySelector('#spMaxRcpt').value),defaultHourlyLimit:Number(body.querySelector('#spHour').value),defaultDailyLimit:Number(body.querySelector('#spDay').value),newAccountHourlyLimit:Number(body.querySelector('#spNew').value)})});appNotice('Đã cập nhật chính sách chống spam.','success')};
   body.querySelector('#addSupp').onclick=async()=>{try{await api('/api/admin/suppressions',{method:'POST',body:JSON.stringify({email:body.querySelector('#suppEmail').value,reason:body.querySelector('#suppReason').value})});open('antispam')}catch(e){appNotice(e.message,'error')}};
   body.querySelectorAll('[data-del-supp]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/suppressions/${b.dataset.delSupp}`,{method:'DELETE'});open('antispam')});
   body.querySelectorAll('[data-q-act]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/queue/${b.dataset.qId}/action`,{method:'POST',body:JSON.stringify({action:b.dataset.qAct})});open('antispam')});
  }else if(name==='system'){
   const [alerts,sessions]=await Promise.all([api('/api/admin/security-alerts'),api('/api/admin/sessions')]);
   body.innerHTML=`<div class="system-grid"><section class="system-card"><span class="sys-kicker">LƯU TRỮ R2 & D1</span><h3>Dữ liệu thư</h3><b>${fmt(system.storage.messageBytes)}</b><p>${system.storage.messageCount} bức thư được lưu trữ an toàn. <button class="secondary" id="exportBackupBtn" type="button" style="margin-top:8px">Xuất bản sao lưu cấu hình JSON</button></p></section><section class="system-card"><span class="sys-kicker">TÊN MIỀN CHÍNH THỨC</span><h3>${esc(system.officialDomain||'mail.skyfirst.io.vn')}</h3><b>${system.accounts.users} tài khoản</b><p>Nhận thư Cloudflare Email Routing: ${system.services.receivingConfigured?'Đã bật':'Chưa bật'}.</p></section><section class="system-card"><span class="sys-kicker">DỊCH VỤ GỬI THƯ</span><h3>Trạng thái gửi thư</h3><b>${system.services.sending?'Đã cấu hình':'Chưa cấu hình'}</b><p>${system.services.sending?'Có tên miền đã xác minh và bật gửi với biến cấu hình cần thiết.':'Cần xác minh tên miền và hoàn tất cấu hình dịch vụ gửi thư (RESEND_API_KEY).'}</p></section></div><h3 style="margin-top:24px">Cảnh báo bảo mật & Uy tín (${alerts.alerts.filter(a=>!a.is_resolved).length} chưa xử lý)</h3><div>${alerts.alerts.map(a=>`<div class="audit"><b>[${esc(a.severity.toUpperCase())}] ${esc(a.title)}</b><span>${esc(a.category)} · ${esc(when(a.created_at))}</span>${a.is_resolved?'<span class="pill ok">Đã xử lý</span>':`<button class="secondary" data-resolve-alert="${a.id}" type="button">Đánh dấu đã xử lý</button>`}</div>`).join('')||'<p class="muted">Không có cảnh báo bảo mật.</p>'}</div><h3 style="margin-top:24px">Phiên đăng nhập đang hoạt động (${sessions.sessions.length})</h3><div>${sessions.sessions.map(s=>`<div class="audit"><b>${esc(s.display_name)} (${esc(s.email)})</b><span>IP: ${esc(s.ip||'N/A')} · ${esc(when(s.last_seen_at||s.created_at))}</span><button class="dangerbtn" data-admin-kill-sess="${s.id}" type="button">Thu hồi phiên</button></div>`).join('')}</div>`;
   body.querySelector('#exportBackupBtn').onclick=async()=>{const b=await api('/api/admin/backup');const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`skyfirst-mail-backup-${new Date().toISOString().slice(0,10)}.json`;a.click()};
   body.querySelectorAll('[data-resolve-alert]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/security-alerts/${b.dataset.resolveAlert}/resolve`,{method:'POST'});open('system')});
   body.querySelectorAll('[data-admin-kill-sess]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/sessions/${b.dataset.adminKillSess}`,{method:'DELETE'});open('system')});
  }else if(name==='audit'){
   if(!audit)audit=await api('/api/admin/audit');
   body.innerHTML=`<h2>Nhật ký hoạt động</h2>${audit.logs.map(a=>`<div class="audit"><b>${esc(a.action)}</b><span>${esc(a.user_name||a.user_email||'Hệ thống')}</span><time>${esc(when(a.created_at))}</time></div>`).join('')||'<p class="empty-admin">Chưa có nhật ký.</p>'}`;
  }
 }
 root.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>open(b.dataset.a));
 await refresh();
}
function inlineConfirm(parent,message){return new Promise(resolve=>{const old=document.querySelector('.inline-confirm');old?.remove();const box=document.createElement('div');box.className='inline-confirm';box.setAttribute('role','alertdialog');box.setAttribute('aria-modal','true');box.innerHTML=`<div class="inline-confirm-card"><span class="confirm-mark">!</span><h3>Xác nhận thao tác</h3><p></p><div class="inline-confirm-actions"><button type="button" class="secondary" data-no>Hủy</button><button type="button" class="dangerbtn" data-yes>Đồng ý</button></div></div>`;box.querySelector('p').textContent=message;document.body.appendChild(box);const done=v=>{box.remove();resolve(v)};box.querySelector('[data-no]').onclick=()=>done(false);box.querySelector('[data-yes]').onclick=()=>done(true);box.addEventListener('keydown',e=>{if(e.key==='Escape')done(false)});box.querySelector('[data-no]').focus()})}
function appNotice(message,type='info'){let el=document.querySelector('#sf-notice-host');if(!el){el=document.createElement('div');el.id='sf-notice-host';el.className='sf-notice-host';el.setAttribute('aria-live','polite');document.body.appendChild(el)}const item=document.createElement('div');item.className=`sf-toast ${type}`;item.textContent=String(message||'');el.appendChild(item);window.setTimeout(()=>item.remove(),6500)}
function uiPrompt(message,initial=''){return new Promise(resolve=>{const w=document.createElement('div');w.className='sf-dialog-backdrop';w.innerHTML=`<section class="sf-dialog" role="dialog" aria-modal="true"><h3></h3><label><span>Giá trị</span><input id="sfPromptValue" autocomplete="off"></label><div class="sf-dialog-actions"><button type="button" class="secondary" data-cancel>Hủy</button><button type="button" class="primary" data-ok>Tiếp tục</button></div></section>`;w.querySelector('h3').textContent=message;const input=w.querySelector('input');input.value=initial;document.body.appendChild(w);const done=v=>{w.remove();resolve(v)};w.querySelector('[data-cancel]').onclick=()=>done(null);w.querySelector('[data-ok]').onclick=()=>done(input.value);w.addEventListener('keydown',e=>{if(e.key==='Escape')done(null);if(e.key==='Enter'){e.preventDefault();done(input.value)}});input.focus();input.select()})}
function uiConfirm(message){return inlineConfirm(document.body,message)}
window.SkyFirstDialog={confirm:uiConfirm,prompt:uiPrompt,alert:(message)=>appNotice(message,'error'),notice:appNotice};

function bulkCreateUsers(parent,domains=[]){
 const w=modal(`<h2>Tạo tài khoản hàng loạt</h2><p class="muted">Mỗi dòng một tài khoản theo định dạng: <b>Họ tên | tên đăng nhập | mật khẩu</b>. Mật khẩu tối thiểu 10 ký tự. Nếu có dòng lỗi, biểu mẫu chỉ giữ lại các dòng chưa tạo để tránh tạo trùng.</p><label>Tên miền mặc định<select id="bulkDomain">${domains.map(d=>`<option value="${esc(d.domain)}">@${esc(d.domain)}</option>`).join('')}</select></label><label>Danh sách tài khoản<textarea id="bulkRows" rows="8" placeholder="Nguyễn Văn A | nguyenvana | MatKhau123!"></textarea></label><div id="bulkCreateStatus" class="notice" role="status" aria-live="polite"></div><div class="account-actions"><button class="primary" id="runBulkCreate" type="button">Tạo tài khoản</button><button class="secondary" id="closeBulkCreate" type="button">Đóng</button></div>`);
 w.classList.add('admin-dialog-wrap');
 w.querySelector('#closeBulkCreate').onclick=()=>w.remove();
 w.querySelector('#runBulkCreate').onclick=async()=>{
  const btn=w.querySelector('#runBulkCreate'),status=w.querySelector('#bulkCreateStatus'),domain=w.querySelector('#bulkDomain').value,box=w.querySelector('#bulkRows'),rows=box.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!domain){status.textContent='Chưa có tên miền email. Hãy thêm tên miền trước.';return}
  if(!rows.length){status.textContent='Hãy nhập ít nhất một dòng.';return}
  btn.disabled=true;btn.textContent='Đang tạo…';let ok=0,errors=[],failedRows=[];
  for(let i=0;i<rows.length;i++){
   const parts=rows[i].split('|').map(x=>x.trim());
   if(parts.length!==3){errors.push(`Dòng ${i+1}: cần 3 trường phân cách bằng |`);failedRows.push(rows[i]);continue}
   const [displayName,local,password]=parts;
   if(!/^[a-z0-9._%+-]{1,64}$/i.test(local)||!displayName||password.length<10){errors.push(`Dòng ${i+1} (${local||'chưa có tên tài khoản'}): kiểm tra tên, tên đăng nhập và mật khẩu từ 10 ký tự.`);failedRows.push(rows[i]);continue}
   try{
    await api('/api/admin/users',{method:'POST',body:JSON.stringify({displayName,email:`${local.toLowerCase()}@${domain}`,password,role:'user',allowNameChange:true,allowAvatarChange:true,allowPasswordChange:true,allowSignatureChange:true,allowThemeChange:true,mailboxActive:true})});ok++
   }catch(e){errors.push(`Dòng ${i+1} (${local}): ${e.message}`);failedRows.push(rows[i])}
  }
  status.textContent=`Tạo thành công ${ok}/${rows.length} tài khoản.`+(errors.length?' '+errors.join(' · '):' Tất cả tài khoản đã được tạo.');
  if(ok){try{await admin()}catch(e){status.textContent+=` Danh sách chưa tải lại được: ${e.message}`}}
  btn.disabled=false;
  if(!failedRows.length){btn.textContent='Đã tạo thành công';btn.disabled=true;setTimeout(()=>{w.remove();appNotice(`Đã tạo thành công ${ok} tài khoản.`,'success')},900)}
  else{box.value=failedRows.join('\n');btn.textContent='Thử tạo lại các dòng lỗi';if(ok)appNotice(`Đã tạo ${ok} tài khoản; còn ${failedRows.length} dòng cần xử lý.`,'info')}
 };
}
function newDomain(parent,done){
  const w=modal(`<div class="domain-create"><div class="domain-big-icon">@</div><h2>Thêm tên miền hoặc tên miền phụ</h2><p class="muted">Hỗ trợ tên miền chính (ví dụ: <b>skyfirst.io.vn</b>) và các tên miền phụ (ví dụ: <b>app.skyfirst.io.vn</b>, <b>notify.skyfirst.io.vn</b>...). Mỗi tên miền được xác minh và quản lý gửi/nhận riêng biệt.</p><label>Tên miền hoặc tên miền phụ<input id="domainName" autocomplete="off" placeholder="app.skyfirst.io.vn"></label><div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px"><span class="muted" style="font-size:11px">Gợi ý nhanh:</span><button type="button" class="secondary v4-mini" onclick="document.querySelector('#domainName').value='app.skyfirst.io.vn'">app.skyfirst.io.vn</button><button type="button" class="secondary v4-mini" onclick="document.querySelector('#domainName').value='notify.skyfirst.io.vn'">notify.skyfirst.io.vn</button><button type="button" class="secondary v4-mini" onclick="document.querySelector('#domainName').value='mail.skyfirst.io.vn'">mail.skyfirst.io.vn</button></div><label>Mục đích sử dụng<select id="domainPurpose"><option value="user_mail">Hộp thư tài khoản người dùng & phòng ban</option><option value="notification">Gửi thông báo tự động hệ thống (notify)</option><option value="service">Dịch vụ tích hợp / Cổng ứng dụng</option></select></label><div class="perm"><label><input id="domainReceive" type="checkbox" checked> Bật nhận thư</label><label><input id="domainSend" type="checkbox"> Bật gửi thư</label></div><div id="dm"></div><button class="primary full" id="addDomain">Thêm tên miền</button></div>`);
  w.classList.add('admin-dialog-wrap');
  w.querySelector('#addDomain').onclick=async()=>{
    const btn=w.querySelector('#addDomain');btn.disabled=true;
    const name=w.querySelector('#domainName').value.trim().toLowerCase();
    if(!name){w.querySelector('#dm').innerHTML=msg('Vui lòng nhập tên miền.');btn.disabled=false;return}
    try{
      await api('/api/admin/domains',{method:'POST',body:JSON.stringify({domain:name,receiveEnabled:w.querySelector('#domainReceive').checked,sendEnabled:w.querySelector('#domainSend').checked})});
      w.remove();appNotice(`Đã thêm tên miền ${name}.`,'success');await done();
    }catch(e){btn.disabled=false;w.querySelector('#dm').innerHTML=msg(e.message)}
  };
}
function newUser(parent,domains=[]){
 const opts=domains.map(d=>`<option value="${esc(d.domain)}">@${esc(d.domain)}</option>`).join('');
 const w=modal(`<h2>Tạo tài khoản</h2><div id="em" role="status" aria-live="polite"></div><div class="grid2"><label>Họ tên<input id="n" maxlength="80" autocomplete="name"></label><label>Tài khoản<div class="email-builder"><input id="local" placeholder="ten.tai.khoan" autocomplete="off"><select id="domain">${opts}</select></div></label><label>Mật khẩu ban đầu<input id="p" type="password" minlength="10" autocomplete="new-password"></label><label>Vai trò<select id="r"><option value="user">Người dùng</option><option value="admin">Quản trị viên</option>${S.me.role==='super_admin'?'<option value="super_admin">Siêu quản trị viên</option>':''}</select></label><label>Loại tài khoản<select id="acctType"><option value="personal">Cá nhân</option><option value="organization">Tổ chức / Đơn vị</option><option value="service">Dịch vụ</option></select></label><label>Đơn vị / Phòng ban<input id="dept" placeholder="Ví dụ: Ban Đối ngoại"></label></div><div class="perm"><label><input id="an" type="checkbox" checked> Cho phép đổi tên</label><label><input id="aa" type="checkbox" checked> Cho phép đổi avatar</label><label><input id="ap" type="checkbox" checked> Cho phép đổi mật khẩu</label><label><input id="as" type="checkbox" checked> Cho phép chữ ký</label><label><input id="at" type="checkbox" checked> Cho phép đổi theme</label><label><input id="ma" type="checkbox" checked> Hộp thư hoạt động</label></div><div class="account-actions"><button class="primary" id="create" type="button">Tạo tài khoản</button><button class="secondary" id="cancelCreate" type="button">Hủy</button></div>`);
 w.classList.add('admin-dialog-wrap');
 w.querySelector('#cancelCreate').onclick=()=>w.remove();
 w.querySelector('#create').onclick=async()=>{
  const btn=w.querySelector('#create'),err=w.querySelector('#em');
  const local=w.querySelector('#local').value.trim().toLowerCase();
  const domain=w.querySelector('#domain').value;
  if(!domain){err.innerHTML=msg('Chưa có tên miền email. Hãy thêm và cấu hình tên miền trong mục Tên miền trước.');return}
  if(!/^[a-z0-9._%+-]{1,64}$/.test(local)){err.innerHTML=msg('Tên tài khoản chỉ được chứa chữ thường, số và các ký tự . _ % + -.');return}
  const payload={displayName:w.querySelector('#n').value.trim(),email:`${local}@${domain}`,password:w.querySelector('#p').value,role:w.querySelector('#r').value,accountType:w.querySelector('#acctType').value,department:w.querySelector('#dept').value.trim(),allowNameChange:w.querySelector('#an').checked,allowAvatarChange:w.querySelector('#aa').checked,allowPasswordChange:w.querySelector('#ap').checked,allowSignatureChange:w.querySelector('#as').checked,allowThemeChange:w.querySelector('#at').checked,mailboxActive:w.querySelector('#ma').checked};
  btn.disabled=true;btn.textContent='Đang tạo…';err.textContent='';
  try{
   const result=await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});
   if(!result.ok&& !result.id)throw new Error(result.error||'Máy chủ chưa xác nhận tạo tài khoản.');
   w.remove();appNotice(`Đã tạo tài khoản ${payload.email}.`,'success');
   try{await admin()}catch(e){appNotice(`Tài khoản đã tạo nhưng chưa tải lại danh sách: ${e.message}`,'error')}
  }catch(e){err.innerHTML=msg(`Không tạo được tài khoản: ${e.message}${e.code?` · Mã ${e.code}`:''}`);btn.disabled=false;btn.textContent='Tạo tài khoản'}
 };
}
function editUser(u,parent){
 const w=modal(`<div class="edit-user-head"><span class="admin-kicker">QUẢN LÝ TÀI KHOẢN</span><h2>Chỉnh sửa tài khoản</h2><p class="muted">${esc(u.email)}</p></div><div class="grid2"><label>Tên hiển thị<input id="n" value="${esc(u.display_name)}" maxlength="80"></label><label>Vai trò<select id="r"><option value="user" ${u.role==='user'?'selected':''}>Người dùng</option><option value="admin" ${u.role==='admin'?'selected':''}>Quản trị viên</option>${S.me.role==='super_admin'?`<option value="super_admin" ${u.role==='super_admin'?'selected':''}>Siêu quản trị viên</option>`:''}</select></label><label>Trạng thái<select id="s"><option value="active" ${u.status==='active'?'selected':''}>Hoạt động</option><option value="disabled" ${u.status==='disabled'?'selected':''}>Đã khóa</option></select></label><label>Mật khẩu mới (không bắt buộc)<input id="rp" type="password" minlength="10" autocomplete="new-password" placeholder="Để trống nếu không đổi"></label><label>Đơn vị / Phòng ban<input id="dept" value="${esc(u.department||'')}"></label><label>Giới hạn gửi/ngày<input id="dlim" type="number" value="${u.daily_send_limit||200}"></label></div><div class="perm"><label><input id="an" type="checkbox" ${u.allow_name_change?'checked':''}> Cho phép đổi tên</label><label><input id="aa" type="checkbox" ${u.allow_avatar_change?'checked':''}> Cho phép đổi avatar</label><label><input id="ap" type="checkbox" ${u.allow_password_change?'checked':''}> Cho phép đổi mật khẩu</label><label><input id="as" type="checkbox" ${u.allow_signature_change?'checked':''}> Cho phép chữ ký</label><label><input id="at" type="checkbox" ${u.allow_theme_change?'checked':''}> Cho phép đổi giao diện</label></div><div id="editMsg" role="status" aria-live="polite"></div><div class="account-actions"><button class="primary" id="save" type="button">Lưu thay đổi</button><button class="dangerbtn" id="deleteUser" type="button">Xóa tài khoản vĩnh viễn</button><button class="secondary" id="cancelEdit" type="button">Đóng</button></div>`);
 w.classList.add('admin-dialog-wrap');
 const message=w.querySelector('#editMsg');
 w.querySelector('#cancelEdit').onclick=()=>w.remove();
  w.querySelector('#deleteUser').onclick=async()=>{
   if(Number(u.id)===Number(S.me.id)){message.innerHTML=msg('Không thể xóa tài khoản đang đăng nhập.');return}
   if(!await inlineConfirm(w,`Xóa vĩnh viễn tài khoản ${u.email}, hộp thư và dữ liệu liên quan? Thao tác này không thể hoàn tác.`))return;
   const btn=w.querySelector('#deleteUser');btn.disabled=true;btn.textContent='Đang xóa…';message.textContent='Đang xác nhận kết quả từ máy chủ…';
   try{
    const result=await api(`/api/admin/users/${u.id}`,{method:'DELETE',body:JSON.stringify({confirm:true,confirmEmail:u.email})});
    if(!result.deleted)throw Object.assign(new Error(result.error||'Máy chủ chưa xác nhận xóa thành công.'),{code:result.code||''});
    w.remove();
    document.querySelectorAll(`.account-row input[data-user-select="${u.id}"]`).forEach(c=>c.closest('.account-row')?.remove());
    if(users?.users){
      users.users=users.users.filter(x=>Number(x.id)!==Number(u.id));
      const countEl=document.querySelector('#adminStats b');if(countEl)countEl.textContent=String(users.users.length);
    }
    appNotice(`Đã xóa vĩnh viễn tài khoản ${u.email}.`,'success');
   }catch(e){message.innerHTML=msg(`Không xóa được tài khoản: ${apiErrorText(e)}`);btn.disabled=false;btn.textContent='Thử xóa lại'}
  };
 w.querySelector('#save').onclick=async()=>{
  const save=w.querySelector('#save'),password=w.querySelector('#rp').value;save.disabled=true;save.textContent='Đang lưu…';message.textContent='';
  try{
   await api(`/api/admin/users/${u.id}`,{method:'PATCH',body:JSON.stringify({displayName:w.querySelector('#n').value,role:w.querySelector('#r').value,status:w.querySelector('#s').value,department:w.querySelector('#dept').value,dailySendLimit:Number(w.querySelector('#dlim').value||200),allowNameChange:w.querySelector('#an').checked,allowAvatarChange:w.querySelector('#aa').checked,allowPasswordChange:w.querySelector('#ap').checked,allowSignatureChange:w.querySelector('#as').checked,allowThemeChange:w.querySelector('#at').checked})});
  }catch(e){message.innerHTML=msg(`Không lưu được thay đổi: ${e.message}${e.code?` · Mã ${e.code}`:''}`);save.disabled=false;save.textContent='Lưu thay đổi';return}
  if(password){
   try{await api(`/api/admin/users/${u.id}/reset-password`,{method:'POST',body:JSON.stringify({password})})}
   catch(e){message.innerHTML=msg(`Thông tin tài khoản đã được lưu, nhưng chưa đặt lại được mật khẩu: ${e.message}${e.code?` · Mã ${e.code}`:''}`);save.disabled=false;save.textContent='Lưu thông tin đã chỉnh sửa';return}
  }
  w.remove();appNotice('Đã lưu thay đổi tài khoản.','success');
  try{await admin()}catch(e){appNotice(`Thay đổi đã lưu, nhưng danh sách chưa làm mới được: ${e.message}`,'error')}
 };
}
function newAlias(parent,users){const w=modal(`<h2>Tạo bí danh</h2><label>Địa chỉ bí danh<input id="a" type="email" placeholder="hr@skyfirst.io.vn"></label><label>Hộp thư đích<select id="m">${users.filter(u=>u.primary_mailbox_id).map(u=>`<option value="${u.primary_mailbox_id}">${esc(u.email)} — ${esc(u.display_name)}</option>`).join('')}</select></label><button class="primary" id="go">Tạo bí danh</button><p class="hint">Bí danh sẽ chuyển thư đến hộp thư đã chọn.</p><div id="am"></div>`);w.classList.add('admin-dialog-wrap');w.querySelector('#go').onclick=async()=>{try{await api('/api/admin/aliases',{method:'POST',body:JSON.stringify({address:w.querySelector('#a').value,mailboxId:Number(w.querySelector('#m').value)})});w.remove();admin()}catch(e){w.querySelector('#am').innerHTML=msg(e.message)}}}
boot();

// Keep email/API data network-only; the worker only caches static UI assets.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {})); }
