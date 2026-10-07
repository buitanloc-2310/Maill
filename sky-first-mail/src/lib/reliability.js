export const RELIABILITY_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS send_operations (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preparing',storage_key TEXT,provider_id TEXT,response_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id))",
  "CREATE INDEX IF NOT EXISTS idx_send_operations_user ON send_operations(user_id,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,window_start INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inbound_receipts (mailbox_id INTEGER NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(mailbox_id,digest))"
];

export async function fingerprint(form){
 const parts=[];
 for(const [key,value] of form.entries()) {
  if(key==='requestId')continue;
  if(typeof value==='string')parts.push([key,value]);
  else parts.push([key,value.name,value.type,await digest(await value.arrayBuffer())]);
 }
 parts.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return digest(new TextEncoder().encode(JSON.stringify(parts)));
}
export async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function boundedRequest(request,maxBytes){
 if(Number(request.headers.get('content-length')||0)>maxBytes)throw Object.assign(new Error('Yêu cầu quá lớn.'),{status:413});
 const reader=request.body?.getReader();if(!reader)return request;
 const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw Object.assign(new Error('Yêu cầu quá lớn.'),{status:413});}chunks.push(value);}
 const data=new Uint8Array(size);let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}
 return new Request(request.url,{method:request.method,headers:request.headers,body:data});
}
export function secureResponse(response){const h=new Headers(response.headers);h.set('x-content-type-options','nosniff');h.set('referrer-policy','no-referrer');h.set('x-frame-options','DENY');h.set('permissions-policy','camera=(), microphone=(), geolocation=()');return new Response(response.body,{status:response.status,headers:h});}
