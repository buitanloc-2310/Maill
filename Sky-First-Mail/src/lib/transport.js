const jsonHeaders={'content-type':'application/json'};
export async function sendExternal(env,domain,message){
 const kind=String(domain?.transport||'resend').toLowerCase();
 if(kind==='resend') return sendResend(env,message);
 if(kind==='gateway') return sendGateway(env,domain,message);
 throw Object.assign(new Error(`Transport ${kind} chưa được hỗ trợ.`),{definitive:true});
}
async function sendResend(env,m){
 if(!env.RESEND_API_KEY)throw Object.assign(new Error('RESEND_API_KEY chưa được cấu hình.'),{definitive:true});
 const attachments=[];
 for(const a of (m.attachments||[])){const bytes=new Uint8Array(await a.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));attachments.push({filename:a.name,content:btoa(binary),content_type:a.type||'application/octet-stream'})}
 for(let index=0;index<(m.inlineAttachments||[]).length;index++){const a=m.inlineAttachments[index],bytes=new Uint8Array(await a.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const cid=String(m.inlineCidMap?.[index]?.cid||'');if(!/^[-a-zA-Z0-9_.@]{1,127}$/.test(cid))throw Object.assign(new Error('Mã ảnh nội tuyến không hợp lệ.'),{definitive:true});attachments.push({filename:a.name,content:btoa(binary),content_type:a.type||'application/octet-stream',content_id:cid})}
 const body={from:m.fromName?`${m.fromName} <${m.fromAddress}>`:m.fromAddress,to:m.to,cc:m.cc?.length?m.cc:undefined,bcc:m.bcc?.length?m.bcc:undefined,subject:m.subject||'',html:m.html||undefined,text:m.text||undefined,reply_to:m.replyTo||undefined,headers:m.headers||undefined,attachments:attachments.length?attachments:undefined};
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{...jsonHeaders,authorization:`Bearer ${env.RESEND_API_KEY}`,'Idempotency-Key':m.idempotencyKey},body:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.message||`Resend HTTP ${r.status}`),{definitive:r.status>=400&&r.status<500});if(typeof data.id!=='string'||!data.id.trim())throw Object.assign(new Error('Resend returned success without a message ID.'),{definitive:false});return {id:data.id,provider:'resend'};
}
export async function sendGateway(env,domain,m){
 if(!env.MTA_GATEWAY_URL||!env.MTA_GATEWAY_TOKEN)throw Object.assign(new Error('MTA gateway chưa được cấu hình.'),{definitive:true});
 if((m.attachments?.length||0)+(m.inlineAttachments?.length||0)>0)throw Object.assign(new Error('MTA gateway hiện chưa hỗ trợ tệp đính kèm hoặc ảnh nội tuyến.'),{definitive:true,publicMessage:'Transport Gateway chưa hỗ trợ tệp đính kèm hoặc ảnh nội tuyến. Thư chưa được gửi; hãy chọn Resend hoặc gửi thư không kèm tệp.'});
 const r=await fetch(env.MTA_GATEWAY_URL,{method:'POST',headers:{...jsonHeaders,authorization:`Bearer ${env.MTA_GATEWAY_TOKEN}`,'Idempotency-Key':m.idempotencyKey},body:JSON.stringify({...m,attachments:undefined,inlineAttachments:undefined,domain:domain.domain})});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||`MTA gateway HTTP ${r.status}`),{definitive:r.status>=400&&r.status<500});const messageId=data.id||data.messageId;if(typeof messageId!=='string'||!messageId.trim())throw Object.assign(new Error('MTA gateway returned success without a message ID.'),{definitive:false});return {id:messageId,provider:'gateway'};
}
