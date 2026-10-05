import sanitizeHtml from 'sanitize-html';
import PostalMime from 'postal-mime';

export async function parseStoredMessage(env, storageKey) {
  const obj = await env.MAIL_STORAGE.get(storageKey);
  if (!obj) return null;
  const raw = await obj.arrayBuffer();
  return await new PostalMime().parse(raw);
}

export function cleanEmailHtml(html='') {
 return sanitizeHtml(String(html),{
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','font','center']),
  allowedAttributes:{'*':['style','title','align','width','height','bgcolor','color'],a:['href','name','target','rel'],img:['src','alt','width','height'],table:['cellpadding','cellspacing','border','width'],td:['colspan','rowspan','width'],th:['colspan','rowspan'],font:['face','size','color']},
  allowedSchemes:['https','http','mailto','cid'],allowProtocolRelative:false,
  allowedStyles:{'*':{'color':[/^[#a-zA-Z0-9(),.%\s-]+$/],'background-color':[/^[#a-zA-Z0-9(),.%\s-]+$/],'font-family':[/^[a-zA-Z0-9 ,"'-]+$/],'font-size':[/^[\d.]+(?:px|pt|em|rem|%)$/],'font-weight':[/^(?:normal|bold|[1-9]00)$/],'font-style':[/^(?:normal|italic)$/],'text-align':[/^(?:left|right|center|justify)$/],'text-decoration':[/^(?:none|underline|line-through)$/],'line-height':[/^[\d.]+(?:px|em|%)?$/],'padding':[/^[\d. pxem%]+$/],'margin':[/^[\d. pxem%auto-]+$/],'border':[/^[\d. pxsolid#a-zA-Z0-9(),% -]+$/],'border-collapse':[/^(?:collapse|separate)$/],'width':[/^[\d.]+(?:px|em|%)$/],'max-width':[/^[\d.]+(?:px|em|%)$/],'height':[/^(?:auto|[\d.]+(?:px|em|%))$/]}},
  transformTags:{a:(tag,attrs)=>({tagName:tag,attribs:{...attrs,rel:'noopener noreferrer',target:'_blank'}})}
 });
}

function encHeader(s='') { return String(s).replace(/[\r\n]+/g,' ').trim(); }
function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out=''; const step=0x8000;
  for(let i=0;i<arr.length;i+=step) out += String.fromCharCode(...arr.subarray(i,i+step));
  return btoa(out);
}

export async function buildMime({from,to,cc=[],bcc=[],subject='',text='',html='',attachments=[],inlineAttachments=[],inlineCidMap=[],messageId=null,inReplyTo=null,references=[],replyTo='',priority='normal'}) {
  const mixed=`sfm_mix_${crypto.randomUUID().replaceAll('-','')}`;
  const alt=`sfm_alt_${crypto.randomUUID().replaceAll('-','')}`;
  const htmlBody=cleanEmailHtml(html || `<div>${String(text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div>`);
  const textBody=String(text||'').trim() || htmlBody.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
  const mid=encHeader(messageId || `<${crypto.randomUUID()}@sky-first-mail.local>`);
  const refs=(Array.isArray(references)?references:[]).map(encHeader).filter(Boolean);
  const lines=[
    `From: ${encHeader(from)}`,
    `To: ${to.map(encHeader).join(', ')}`,
    ...(cc.length?[`Cc: ${cc.map(encHeader).join(', ')}`]:[]),
    `Subject: ${encHeader(subject || '(Không có tiêu đề)')}`,
    ...(replyTo?[`Reply-To: ${encHeader(replyTo)}`]:[]),
    ...(priority==='high'?['X-Priority: 1','Importance: high']:priority==='low'?['X-Priority: 5','Importance: low']:[]),
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${mid}`,
    ...(inReplyTo?[`In-Reply-To: ${encHeader(inReplyTo)}`]:[]),
    ...(refs.length?[`References: ${refs.join(' ')}`]:[]),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`, '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit','',
    textBody,'',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit','',
    htmlBody,'',
    `--${alt}--`,''
  ];
  const cidByName=new Map((Array.isArray(inlineCidMap)?inlineCidMap:[]).map(x=>[String(x?.name||''),String(x?.cid||'')]));
  for (const a of inlineAttachments) {
    const ab=await a.arrayBuffer();
    const b64=toBase64(ab).replace(/(.{76})/g,'$1\r\n');
    const cid=encHeader(cidByName.get(String(a.name||''))||`sfm-inline-${crypto.randomUUID()}`);
    lines.push(`--${mixed}`,`Content-Type: ${/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.type||'')?a.type:'application/octet-stream'}; name="${encHeader(a.name||'inline-image').replace(/["\\]/g,'_')}"`,`Content-Disposition: inline; filename="${encHeader(a.name||'inline-image').replace(/["\\]/g,'_')}"`,`Content-ID: <${cid}>`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  for (const a of attachments) {
    const ab=await a.arrayBuffer();
    const b64=toBase64(ab).replace(/(.{76})/g,'$1\r\n');
    lines.push(`--${mixed}`,`Content-Type: ${/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.type||'')?a.type:'application/octet-stream'}; name="${encHeader(a.name||'attachment').replace(/["\\]/g,'_')}"`,`Content-Disposition: attachment; filename="${encHeader(a.name||'attachment').replace(/["\\]/g,'_')}"`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  lines.push(`--${mixed}--`,'');
  return new TextEncoder().encode(lines.join('\r\n')).buffer;
}
