import {json,badRequest} from './http.js';
import {buildMime,cleanEmailHtml} from './mail.js';
import {fingerprint} from './reliability.js';
const email=value=>String(value||'').trim().toLowerCase();
const valid=value=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const list=value=>[...new Set(String(value||'').split(/[;,]/).map(email).filter(Boolean))];
export async function reliableCompose(request,env,user,services){
 const form=await request.formData();
 const fromMb=await services.resolveSenderIdentity(env,user.id,Number(form.get('mailboxId')),email(form.get('senderAddress')));
 if(!fromMb)return badRequest('Địa chỉ gửi không hợp lệ.');
 const to=list(form.get('to')),cc=list(form.get('cc')).filter(x=>!to.includes(x)),bcc=list(form.get('bcc')).filter(x=>!to.includes(x)&&!cc.includes(x));
 if(!to.length||[...to,...cc,...bcc].some(x=>!valid(x)))return badRequest('Địa chỉ người nhận không hợp lệ.');
 if(to.length+cc.length+bcc.length>50)return badRequest('Mỗi thư tối đa 50 người nhận.');
 const replyTo=email(form.get('replyTo'));if(replyTo&&!valid(replyTo))return badRequest('Reply-To không hợp lệ.');
 const subject=String(form.get('subject')||'').replace(/[\r\n]/g,' ').slice(0,998),text=String(form.get('text')||'').slice(0,500000),html=cleanEmailHtml(String(form.get('html')||'').slice(0,500000)),priority=String(form.get('priority')||'normal');
 const attachments=form.getAll('attachments').filter(x=>typeof x?.arrayBuffer==='function'),inlineAttachments=form.getAll('inlineAttachments').filter(x=>typeof x?.arrayBuffer==='function');
 if([...attachments,...inlineAttachments].reduce((n,x)=>n+x.size,0)>12*1024*1024)return badRequest('Tổng tệp và ảnh nội tuyến tối đa 12 MB.');
 if(attachments.length+inlineAttachments.length>30)return badRequest('Mỗi thư tối đa 30 tệp.');
 let inlineCidMap=[];try{inlineCidMap=JSON.parse(String(form.get('inlineCidMap')||'[]'))}catch{}
 if(!Array.isArray(inlineCidMap)||inlineCidMap.some(x=>!x||!/^[-a-zA-Z0-9_.@]+$/.test(x.cid||'')))return badRequest('Mã ảnh nội tuyến không hợp lệ.');
 if(inlineAttachments.some(a=>!/^image\/(png|jpeg|gif|webp)$/.test(a.type)||!inlineCidMap.some(x=>x.name===a.name)))return badRequest('Ảnh nội tuyến phải là PNG, JPEG, GIF hoặc WebP và có mã nhúng hợp lệ.');
 const groups={to:[],cc:[],bcc:[]};
 for(const [kind,addresses] of Object.entries({to,cc,bcc}))for(const addr of addresses){const mb=await services.resolveMailbox(env,addr);groups[kind].push({addr,mb});}
 const external=kind=>groups[kind].filter(x=>!x.mb).map(x=>x.addr);
 const hasExternal=['to','cc','bcc'].some(k=>external(k).length);
 if(hasExternal){const domain=await env.DB.prepare('SELECT send_enabled,status,transport FROM managed_domains WHERE domain=? COLLATE NOCASE').bind(fromMb.sender_address.split('@')[1]).first();if(!domain?.send_enabled||domain.status==='disabled')return badRequest('Tên miền gửi chưa được bật hoặc transport chưa cấu hình.');}
 const supplied=String(form.get('requestId')||request.headers.get('idempotency-key')||'');
 if(supplied && !/^[a-zA-Z0-9_-]{16,100}$/.test(supplied))return badRequest('Mã yêu cầu gửi không hợp lệ.');
 const id=`${user.id}_${supplied||crypto.randomUUID()}`,hash=await fingerprint(form);
 const reservation=await env.DB.prepare('INSERT OR IGNORE INTO send_operations(id,user_id,request_hash) VALUES(?,?,?)').bind(id,user.id,hash).run();
 if(!reservation.meta.changes){const old=await env.DB.prepare('SELECT * FROM send_operations WHERE id=? AND user_id=?').bind(id,user.id).first();if(old.request_hash!==hash)return json({ok:false,error:'Nội dung đã thay đổi sau yêu cầu gửi. Hãy mở một thư mới.',operationId:id},409);if(old.status==='completed')return json(JSON.parse(old.response_json));return json({ok:false,error:'Yêu cầu gửi đã được ghi nhận. Cần kiểm tra trạng thái trước khi gửi lại để tránh thư trùng.',operationId:id,status:old.status},409);}
 let providerStarted=false,providerId=null,providerName='external';
 try{
  let inReplyTo=null;const replyId=Number(form.get('replyToMessageId'));if(replyId){const original=await services.ownsMessage(env,user.id,replyId);inReplyTo=original?.message_id_header||null;}
  const references=inReplyTo?[inReplyTo]:[],messageId=`<${id}@${fromMb.sender_address.split('@')[1]}>`,storageKey=`messages/outbound/${id}.eml`;
  const raw=await buildMime({from:fromMb.sender_address,to,cc,bcc,subject,text,html,attachments,inlineAttachments,inlineCidMap,messageId,inReplyTo,references,replyTo,priority});
  // Persist recoverable MIME before contacting the external provider.
  await env.MAIL_STORAGE.put(storageKey,raw,{httpMetadata:{contentType:'message/rfc822'}});
  await env.DB.prepare("UPDATE send_operations SET storage_key=?,status='prepared',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(storageKey,id).run();
  if(hasExternal){
   const headers={};if(inReplyTo){headers['In-Reply-To']=inReplyTo;headers.References=references.join(' ');}if(priority==='high')headers['X-Priority']='1';
   await env.DB.prepare("UPDATE send_operations SET status='sending',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
   providerStarted=true;
   const result=await services.sendWithResend(env,{fromAddress:fromMb.sender_address,fromName:user.display_name||fromMb.display_name,to:external('to').length?external('to'):to,cc:external('cc'),bcc:external('bcc'),subject,html,text,attachments,inlineAttachments,inlineCidMap,headers,replyTo,idempotencyKey:id});providerId=result.id;providerName=result.provider||'external';
   await env.DB.prepare("UPDATE send_operations SET provider_id=?,status='accepted',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(providerId,id).run();
  }
  const now=new Date().toISOString(),preview=(text||html.replace(/<[^>]+>/g,' ')).slice(0,180);
  const insert=(mailbox,direction,folder,recipients,blind,read)=>env.DB.prepare(`INSERT INTO messages(mailbox_id,direction,folder,sender,recipients_json,cc_json,bcc_json,subject,preview,storage_key,raw_size,is_read,status,sent_at,received_at,message_id_header,thread_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(mailbox,direction,folder,fromMb.sender_address,JSON.stringify(recipients),JSON.stringify(cc),JSON.stringify(blind),subject,preview,storageKey,raw.byteLength,read,direction==='outbound'?'sent':'received',now,now,messageId,inReplyTo||messageId);
  const response={ok:true,internal:!hasExternal,external:hasExternal,provider:hasExternal?providerName:null,providerId,operationId:id};
  const statements=[insert(fromMb.id,'outbound','sent',to,bcc,1)];const recipients=new Map();for(const x of [...groups.to,...groups.cc,...groups.bcc])if(x.mb && !(hasExternal&&!external('to').length&&to.includes(x.addr)))recipients.set(x.mb.id,x);
  for(const {mb} of recipients.values())statements.push(insert(mb.id,'inbound','inbox',to,[],0));
  if(providerId)statements.push(env.DB.prepare("INSERT INTO delivery_events(provider,provider_message_id,event_type,detail_json) VALUES(?,?,'accepted',?)").bind(providerName,providerId,JSON.stringify({operationId:id})));
  statements.push(env.DB.prepare("UPDATE send_operations SET status='completed',response_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(JSON.stringify(response),id));
  // Local delivery and completion commit together; a partial batch rolls back.
  await env.DB.batch(statements);
  for(const {mb} of recipients.values())await services.notify(env,mb.user_id,`Thư mới từ ${user.display_name}`,subject,'mail');
  await services.audit(env,user.id,'mail.sent','send_operation',id,{providerId,recipientCount:to.length+cc.length+bcc.length});
  return json(response);
 }catch(error){
  const status=providerId?'accepted_pending_local':providerStarted&&!error.definitive?'uncertain':'failed';
  try{await env.DB.prepare('UPDATE send_operations SET status=?,provider_id=COALESCE(?,provider_id),updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,providerId,id).run();}catch{}
  console.error('SEND_OPERATION_FAILED',{operationId:id,status});
  return json({ok:false,error:status==='failed'?'Chưa gửi được thư. Liên hệ quản trị viên cùng mã yêu cầu để kiểm tra.':'Chưa xác nhận đầy đủ kết quả gửi. Không gửi lại thư mới trước khi đối chiếu để tránh trùng.',operationId:id,status},502);
 }
}
