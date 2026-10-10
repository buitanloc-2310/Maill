import PostalMime from 'postal-mime';

export async function parseStoredMessage(env, storageKey) {
  const obj = await env.MAIL_STORAGE.get(storageKey);
  if (!obj) return null;
  const raw = await obj.arrayBuffer();
  return await new PostalMime().parse(raw);
}

export function cleanEmailHtml(html='') {
  // Conservative sanitization for untrusted message/template HTML. This is intentionally
  // dependency-free so Worker deployments do not rely on a browser DOM implementation.
  let value=String(html??'').replace(/\u0000/g,'');
  value=value.replace(/<!--[\s\S]*?-->/g,'');
  value=value.replace(/<(script|iframe|object|embed|form|svg|math|video|audio|canvas|template|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  value=value.replace(/<(script|iframe|object|embed|form|svg|math|video|audio|canvas|template|applet)\b[^>]*\/?>/gi,'');
  value=value.replace(/<\/(script|iframe|object|embed|form|svg|math|video|audio|canvas|template|applet)\s*>/gi,'');
  value=value.replace(/<(meta|base|link)\b[^>]*>/gi,'');
  value=value.replace(/\s+on[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
  value=value.replace(/\s+(srcdoc|formaction|action)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
  const decodeEntities = input => String(input).replace(/&#(x[\da-f]+|\d+);?/gi,(_,n)=>{
    const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    return Number.isFinite(cp)&&cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'';
  }).replace(/&colon;/gi,':').replace(/&tab;/gi,'\t').replace(/&newline;/gi,'\n');
  value=value.replace(/\s+(href|src|xlink:href|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,(full,name,double,single,unquoted)=>{
    const raw=double??single??unquoted??'';
    const normalized=decodeEntities(raw).replace(/[\u0000-\u0020\u007f]+/g,'').toLowerCase();
    if(/^\s*javascript:/.test(normalized)||/^vbscript:/.test(normalized)||/^data:text\/html/.test(normalized))return '';
    if(name.toLowerCase()==='background'||name.toLowerCase()==='poster')return '';
    if(name.toLowerCase()==='src' && /^data:(?!image\/(?:png|gif|jpe?g|webp);base64,)/i.test(raw))return '';
    return ` ${name.toLowerCase()}="${String(raw).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"`;
  });
  value=value.replace(/\s+style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,(full,double,single,unquoted)=>{
    const css=double??single??unquoted??'';
    if(/expression\s*\(|javascript\s*:|vbscript\s*:|@import|url\s*\(/i.test(decodeEntities(css)))return '';
    return ` style="${css.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"`;
  });
  // Remove unsafe CSS imports/URLs but preserve ordinary email styles such as colors and tables.
  value=value.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,(_,attrs,css)=>{
    const safe=String(css).replace(/@import[^;]*;?/gi,'').replace(/expression\s*\([^)]*\)/gi,'').replace(/url\s*\([^)]*\)/gi,'');
    return `<style>${safe}</style>`;
  });
  return value;
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
    lines.push(`--${mixed}`,`Content-Type: ${a.type||'application/octet-stream'}; name="${encHeader(a.name||'inline-image')}"`,`Content-Disposition: inline; filename="${encHeader(a.name||'inline-image')}"`,`Content-ID: <${cid}>`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  for (const a of attachments) {
    const ab=await a.arrayBuffer();
    const b64=toBase64(ab).replace(/(.{76})/g,'$1\r\n');
    lines.push(`--${mixed}`,`Content-Type: ${a.type||'application/octet-stream'}; name="${encHeader(a.name||'attachment')}"`,`Content-Disposition: attachment; filename="${encHeader(a.name||'attachment')}"`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  lines.push(`--${mixed}--`,'');
  return new TextEncoder().encode(lines.join('\r\n')).buffer;
}
