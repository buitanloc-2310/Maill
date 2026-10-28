import { json, badRequest } from './auth.js';
import { buildMime, cleanEmailHtml } from './mail.js';
import { fingerprint, digest } from './security.js';
import { isAllowedAvatarImage } from './content-policy.js';
import { evaluateOutboundPolicy, generateUnsubscribeUrl, EMAIL_CATEGORIES } from './governance.js';

const email=value=>String(value||'').trim().toLowerCase();
const valid=value=>String(value||'').length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value||'');
const list=value=>[...new Set(String(value||'').split(/[;,]/).map(email).filter(Boolean))];

export async function reliableCompose(request,env,user,services){
 const form=await request.formData();
 const fromMb=await services.resolveSenderIdentity(env,user.id,Number(form.get('mailboxId')),email(form.get('senderAddress')));
 if(!fromMb)return badRequest('Địa chỉ gửi không hợp lệ hoặc bạn chưa được cấp quyền gửi thay cho danh tính này.');
 const to=list(form.get('to')),cc=list(form.get('cc')).filter(x=>!to.includes(x)),bcc=list(form.get('bcc')).filter(x=>!to.includes(x)&&!cc.includes(x));
 if(!to.length||[...to,...cc,...bcc].some(x=>!valid(x)))return badRequest('Địa chỉ người nhận không hợp lệ.');
 if(to.length+cc.length+bcc.length>50)return badRequest('Mỗi thư tối đa 50 người nhận.');
 const replyTo=email(form.get('replyTo'));if(replyTo&&!valid(replyTo))return badRequest('Reply-To không hợp lệ.');
 if(replyTo&&replyTo!==fromMb.sender_address){
  // Prevent internal Reply-To spoofing: if Reply-To uses a managed domain, the user must be authorized for it.
  const replyDomain=replyTo.split('@')[1]||'';
  const managedReply=await env.DB.prepare('SELECT id FROM managed_domains WHERE lower(domain)=lower(?) LIMIT 1').bind(replyDomain).first();
  if(managedReply){
   const authorizedReply=await services.resolveSenderIdentity(env,user.id,fromMb.id,replyTo);
   if(!authorizedReply)return badRequest('Không được phép đặt Reply-To mạo danh địa chỉ nội bộ chưa được cấp quyền.');
  }
 }
 const subject=String(form.get('subject')||'').replace(/[\r\n]/g,' ').slice(0,998),text=String(form.get('text')||'').slice(0,500000),html=cleanEmailHtml(String(form.get('html')||'').slice(0,500000)),priority=String(form.get('priority')||'normal');
 const rawCategory=String(form.get('emailCategory')||'personal').toLowerCase();
 const emailCategory=EMAIL_CATEGORIES.includes(rawCategory)?rawCategory:'personal';
 const undoHoldSeconds=Math.min(120,Math.max(0,Number(form.get('undoHoldSeconds')||0)));
 const scheduledForRaw=String(form.get('scheduledFor')||'').trim();
 let scheduledFor=null;
 if(scheduledForRaw){
  const ts=Date.parse(scheduledForRaw);
  if(!Number.isFinite(ts)||ts<=Date.now())return badRequest('Thời gian hẹn giờ gửi phải nằm trong tương lai.');
  scheduledFor=new Date(ts).toISOString();
 }
 const attachments=form.getAll('attachments').filter(x=>typeof x?.arrayBuffer==='function'),inlineAttachments=form.getAll('inlineAttachments').filter(x=>typeof x?.arrayBuffer==='function');
 if([...attachments,...inlineAttachments].reduce((n,x)=>n+x.size,0)>12*1024*1024)return badRequest('Tổng tệp và ảnh nội tuyến tối đa 12 MB.');
 if(attachments.length+inlineAttachments.length>100)return badRequest('Mỗi thư tối đa 100 tệp, trong giới hạn tổng dung lượng 12 MB.');
 let inlineCidMap=[];try{inlineCidMap=JSON.parse(String(form.get('inlineCidMap')||'[]'))}catch{}
 if(!Array.isArray(inlineCidMap)||inlineCidMap.length!==inlineAttachments.length||inlineCidMap.some((x,i)=>!x||String(x.name||'')!==String(inlineAttachments[i]?.name||'')||!/^[-a-zA-Z0-9_.@]{1,127}$/.test(x.cid||'')))return badRequest('Mã ảnh nội tuyến không hợp lệ.');
 if(new Set(inlineCidMap.map(x=>x.cid)).size!==inlineCidMap.length)return badRequest('Mỗi ảnh nội tuyến phải có một mã CID riêng.');
 if(inlineAttachments.some(a=>!/^image\/(png|jpeg|gif|webp)$/.test(String(a.type||'').split(';')[0].toLowerCase())))return badRequest('Ảnh nội tuyến phải là PNG, JPEG, GIF hoặc WebP.');
 for(const a of inlineAttachments){if(!isAllowedAvatarImage(a.type,new Uint8Array(await a.arrayBuffer())))return badRequest('Nội dung ảnh nội tuyến không khớp với định dạng ảnh khai báo.');}

 // Run anti-spam, suppression list, rate-limit, and risk evaluation before persisting or sending
 const policyCheck=await evaluateOutboundPolicy(env,user,fromMb,{to,cc,bcc,subject,text,html,attachments:[...attachments,...inlineAttachments],emailCategory});
 if(!policyCheck.allowed)return json({ok:false,error:policyCheck.error,risk:policyCheck.risk||null},policyCheck.status||400);

 // Protect recipient privacy on promotional bulk sends (>1 external/total recipient in To/Cc)
 if(emailCategory==='promotional'&&(to.length+cc.length)>1){
  return badRequest('Đối với thư quảng bá gửi nhiều người, hãy đưa danh sách người nhận vào trường Bcc (và chỉ đặt địa chỉ đại diện ở trường Đến) để bảo vệ quyền riêng tư người nhận.');
 }

 const groups={to:[],cc:[],bcc:[]};
 for(const [kind,addresses] of Object.entries({to,cc,bcc}))for(const addr of addresses){const mb=await services.resolveMailbox(env,addr);groups[kind].push({addr,mb});}
 const external=kind=>groups[kind].filter(x=>!x.mb).map(x=>x.addr);
 const hasExternal=['to','cc','bcc'].some(k=>external(k).length);
 if(hasExternal){const domain=await env.DB.prepare('SELECT send_enabled,status,transport FROM managed_domains WHERE domain=? COLLATE NOCASE').bind(fromMb.sender_address.split('@')[1]).first();if(!domain?.send_enabled||domain.status==='disabled')return badRequest('Tên miền gửi chưa được bật hoặc transport chưa cấu hình.');if(String(domain.transport||'resend').toLowerCase()==='resend'&&!external('to').length)return badRequest('Resend yêu cầu có ít nhất một địa chỉ ngoài hệ thống trong trường Đến. Để tránh gửi trùng cho người nhận nội bộ, hãy chuyển một người nhận ngoài vào Đến hoặc cấu hình MTA Gateway cho trường hợp chỉ có Cc/Bcc bên ngoài.');}
 const supplied=String(form.get('requestId')||request.headers.get('idempotency-key')||'');
 if(supplied && !/^[a-zA-Z0-9_-]{16,100}$/.test(supplied))return badRequest('Mã yêu cầu gửi không hợp lệ.');
 const id=`${user.id}_${supplied||crypto.randomUUID()}`,hash=await fingerprint(form);
 const reservation=await env.DB.prepare('INSERT OR IGNORE INTO send_operations(id,user_id,request_hash) VALUES(?,?,?)').bind(id,user.id,hash).run();
 if(!reservation.meta.changes){const old=await env.DB.prepare('SELECT * FROM send_operations WHERE id=? AND user_id=?').bind(id,user.id).first();if(old.request_hash!==hash)return json({ok:false,error:'Nội dung đã thay đổi sau yêu cầu gửi. Hãy mở một thư mới.',operationId:id},409);if(old.status==='completed'||old.status==='undo_window'||old.status==='scheduled')return json(JSON.parse(old.response_json));return json({ok:false,error:'Yêu cầu gửi đã được ghi nhận. Cần kiểm tra trạng thái trước khi gửi lại để tránh thư trùng.',operationId:id,status:old.status},409);}
 let providerStarted=false,providerId=null,providerName='external';
 try{
  let inReplyTo=null;const replyId=Number(form.get('replyToMessageId'));if(replyId){const original=await services.ownsMessage(env,user.id,replyId);inReplyTo=original?.message_id_header||null;}
  const references=inReplyTo?[inReplyTo]:[],messageId=`<${id}@${fromMb.sender_address.split('@')[1]}>`,storageKey=`messages/outbound/${id}.eml`;
  const reqOrigin=new URL(request.url).origin;
  const listUnsubscribe=emailCategory==='promotional'?await generateUnsubscribeUrl(env,reqOrigin,to[0]):'';
  const senderHeader=fromMb.sender_kind==='delegated'&&fromMb.permission_mode==='send_on_behalf'?user.email:'';
  const raw=await buildMime({from:fromMb.sender_address,sender:senderHeader,to,cc,bcc,subject,text,html,attachments,inlineAttachments,inlineCidMap,messageId,inReplyTo,references,replyTo,priority,listUnsubscribe});
  const contentSha256=await digest(new Uint8Array(raw));
  // Persist recoverable MIME before contacting the external provider.
  await env.MAIL_STORAGE.put(storageKey,raw,{httpMetadata:{contentType:'message/rfc822'}});
  await env.DB.prepare("UPDATE send_operations SET storage_key=?,status='prepared',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(storageKey,id).run();

  // If Undo Send window, Scheduled Send, or High-Risk Hold is active, hold in send_queue BEFORE external dispatch!
  if(undoHoldSeconds>0||scheduledFor||policyCheck.holdForReview){
   const queueStatus=policyCheck.holdForReview?'paused':scheduledFor?'scheduled':'undo_window';
   const deliverAfter=scheduledFor||(undoHoldSeconds>0?new Date(Date.now()+undoHoldSeconds*1000).toISOString():new Date().toISOString());
   const heldResponse={
    ok:true,
    queued:true,
    status:queueStatus,
    operationId:id,
    deliverAfter,
    undoHoldSeconds,
    canUndo:queueStatus==='undo_window'||queueStatus==='scheduled',
    risk:policyCheck.risk
   };
   await env.DB.batch([
    env.DB.prepare(`INSERT INTO send_queue(operation_id,user_id,mailbox_id,sender_address,recipients_json,cc_json,bcc_json,subject,text_body,html_body,reply_to,in_reply_to,priority,email_category,storage_key,status,risk_score,risk_flags_json,deliver_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
     .bind(id,user.id,fromMb.id,fromMb.sender_address,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,text,html,replyTo||null,inReplyTo||null,priority,emailCategory,storageKey,queueStatus,policyCheck.risk?.score||0,JSON.stringify(policyCheck.risk?.flags||[]),deliverAfter),
    env.DB.prepare("UPDATE send_operations SET status=?,response_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
     .bind(queueStatus,JSON.stringify(heldResponse),id)
   ]);
   await services.audit(env,user.id,queueStatus==='undo_window'?'mail.undo_hold':'mail.queued','send_operation',id,{queueStatus,deliverAfter,senderAddress:fromMb.sender_address});
   return json(heldResponse);
  }

  const effectiveDisplayName=fromMb.sender_kind==='delegated'?(fromMb.display_name||fromMb.sender_address):(user.display_name||fromMb.display_name);
  if(hasExternal){
   const headers={};if(inReplyTo){headers['In-Reply-To']=inReplyTo;headers.References=references.join(' ');}if(priority==='high')headers['X-Priority']='1';if(listUnsubscribe){headers['List-Unsubscribe']=`<${listUnsubscribe}>`;headers['List-Unsubscribe-Post']='List-Unsubscribe=One-Click';}
   await env.DB.prepare("UPDATE send_operations SET status='sending',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
   providerStarted=true;
   const result=await services.sendWithResend(env,{fromAddress:fromMb.sender_address,fromName:effectiveDisplayName,to:external('to'),cc:external('cc'),bcc:external('bcc'),subject,html,text,attachments,inlineAttachments,inlineCidMap,headers,replyTo,idempotencyKey:id});providerId=result.id;providerName=result.provider||'external';
   await env.DB.prepare("UPDATE send_operations SET provider_id=?,status='accepted',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(providerId,id).run();
  }
  const now=new Date().toISOString(),preview=(text||html.replace(/<[^>]+>/g,' ')).slice(0,180);
  const insert=(mailbox,direction,folder,recipients,blind,read)=>env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,bcc_json,subject,preview,storage_key,raw_size,content_sha256,hash_recorded_at,is_read,status,sent_at,received_at,message_id_header,thread_key,email_category,risk_score,actor_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(mailbox,direction,folder,fromMb.sender_address,JSON.stringify(recipients),JSON.stringify(cc),JSON.stringify(blind),subject,preview,storageKey,raw.byteLength,contentSha256,now,read,direction==='outbound'?'sent':'received',now,now,messageId,inReplyTo||messageId,emailCategory,policyCheck.risk?.score||0,user.id);
  const response={ok:true,internal:!hasExternal,external:hasExternal,provider:hasExternal?providerName:null,providerId,operationId:id,senderKind:fromMb.sender_kind||'mailbox',risk:policyCheck.risk};
  const statements=[insert(fromMb.id,'outbound','sent',to,bcc,1)];const recipients=new Map();for(const x of [...groups.to,...groups.cc,...groups.bcc])if(x.mb && !(hasExternal&&!external('to').length&&to.includes(x.addr)))recipients.set(x.mb.id,x);
  for(const {mb} of recipients.values())statements.push(insert(mb.id,'inbound','inbox',to,[],0));
  if(providerId)statements.push(env.DB.prepare("INSERT INTO delivery_events(provider,provider_message_id,event_type,detail_json) VALUES(?,?,'accepted',?)").bind(providerName,providerId,JSON.stringify({operationId:id})));
  statements.push(env.DB.prepare("UPDATE send_operations SET status='completed',response_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(JSON.stringify(response),id));
  // Local delivery and completion commit together; a partial batch rolls back.
  await env.DB.batch(statements);
  for(const {mb} of recipients.values())await services.notify(env,mb.user_id,`Thư mới từ ${effectiveDisplayName}`,subject,'mail');
  await services.audit(env,user.id,fromMb.sender_kind==='delegated'?'mail.sent.delegated':'mail.sent','send_operation',id,{providerId,senderAddress:fromMb.sender_address,senderKind:fromMb.sender_kind,recipientCount:to.length+cc.length+bcc.length});
  return json(response);
 }catch(error){
  const status=providerId?'accepted_pending_local':providerStarted&&!error.definitive?'uncertain':'failed';
  try{await env.DB.prepare('UPDATE send_operations SET status=?,provider_id=COALESCE(?,provider_id),updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,providerId,id).run();}catch{}
  console.error('SEND_OPERATION_FAILED',{operationId:id,status});
  return json({ok:false,error:status==='failed'?(error.publicMessage||'Chưa gửi được thư. Liên hệ quản trị viên cùng mã yêu cầu để kiểm tra.'):'Chưa xác nhận đầy đủ kết quả gửi. Không gửi lại thư mới trước khi đối chiếu để tránh trùng.',operationId:id,status},502);
 }
}
