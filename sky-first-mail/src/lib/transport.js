const jsonHeaders={'content-type':'application/json'};
export async function sendExternal(env,domain,message){
 const kind=String(domain?.transport||'resend').toLowerCase();
 if(kind==='resend') return sendResend(env,message);
 if(kind==='gateway') return sendGateway(env,domain,message);
 throw Object.assign(new Error(`Transport ${kind} chưa được hỗ trợ.`),{definitive:true});
}
async function sendResend(env,m){
 if(!env.RESEND_API_KEY)throw Object.assign(new Error('RESEND_API_KEY chưa được cấu hình.'),{definitive:true});
 const attachments=[];for(const a of [...(m.attachments||[]),...(m.inlineAttachments||[])]){const bytes=new Uint8Array(await a.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const item={filename:a.name,content:btoa(binary),content_type:a.type||'application/octet-stream'};const cid=(m.inlineCidMap||[]).find(x=>x.name===a.name)?.cid;if(cid)item.content_id=cid;attachments.push(item)}
 const body={from:m.fromName?`${m.fromName} <${m.fromAddress}>`:m.fromAddress,to:m.to,cc:m.cc?.length?m.cc:undefined,bcc:m.bcc?.length?m.bcc:undefined,subject:m.subject||'',html:m.html||undefined,text:m.text||undefined,reply_to:m.replyTo||undefined,headers:m.headers||undefined,attachments:attachments.length?attachments:undefined};
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{...jsonHeaders,authorization:`Bearer ${env.RESEND_API_KEY}`,'Idempotency-Key':m.idempotencyKey},body:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.message||`Resend HTTP ${r.status}`),{definitive:r.status>=400&&r.status<500});return {id:data.id,provider:'resend'};
}
async function sendGateway(env,domain,m){
 if(!env.MTA_GATEWAY_URL||!env.MTA_GATEWAY_TOKEN)throw Object.assign(new Error('MTA gateway chưa được cấu hình.'),{definitive:true});
 const r=await fetch(env.MTA_GATEWAY_URL,{method:'POST',headers:{...jsonHeaders,authorization:`Bearer ${env.MTA_GATEWAY_TOKEN}`,'Idempotency-Key':m.idempotencyKey},body:JSON.stringify({...m,attachments:undefined,inlineAttachments:undefined,domain:domain.domain})});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||`MTA gateway HTTP ${r.status}`),{definitive:r.status>=400&&r.status<500});return {id:data.id||data.messageId,provider:'gateway'};
}
