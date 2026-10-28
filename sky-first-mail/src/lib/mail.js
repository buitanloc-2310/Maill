import { safeMimeType, safeMimeFilename } from './content-policy.js';

let cachedPostalMime = undefined;
async function getPostalMime() {
  if (cachedPostalMime !== undefined) return cachedPostalMime;
  try {
    const mod = await import('postal-mime');
    cachedPostalMime = mod.default || mod;
  } catch {
    cachedPostalMime = null;
  }
  return cachedPostalMime;
}

function decodeRfc2047(text = '') {
  return String(text || '').replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const bin = atob(data.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder(charset || 'utf-8').decode(bytes);
      }
      const qp = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
      const bytes = Uint8Array.from(qp, c => c.charCodeAt(0));
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      return data;
    }
  }).replace(/\r?\n[ \t]+/g, '');
}

function parseHeadersBlock(rawHeader = '') {
  const unfolded = String(rawHeader || '').replace(/\r?\n([ \t]+)/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  }
  return headers;
}

function decodeParamFilename(headerVal = '') {
  const star = headerVal.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {}
  }
  const regular = headerVal.match(/(?:filename|name)="?([^";\r\n]+)"?/i);
  return regular ? decodeRfc2047(regular[1].trim()) : null;
}

function parseMimeFallback(rawBuffer) {
  const rawBytes = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer);
  const rawStr = new TextDecoder('utf-8').decode(rawBytes);
  const splitIdx = rawStr.indexOf('\r\n\r\n') >= 0 ? rawStr.indexOf('\r\n\r\n') : rawStr.indexOf('\n\n');
  const sepLen = rawStr.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
  const headerPart = splitIdx >= 0 ? rawStr.slice(0, splitIdx) : rawStr;
  const bodyPart = splitIdx >= 0 ? rawStr.slice(splitIdx + sepLen) : '';
  const headers = parseHeadersBlock(headerPart);
  const result = {
    subject: decodeRfc2047(headers['subject'] || ''),
    from: headers['from'] ? { text: decodeRfc2047(headers['from']), address: headers['from'] } : null,
    to: headers['to'] ? headers['to'].split(',').map(x => ({ address: x.trim() })) : [],
    cc: headers['cc'] ? headers['cc'].split(',').map(x => ({ address: x.trim() })) : [],
    date: headers['date'] || null,
    text: '',
    html: '',
    attachments: []
  };

  function walkPart(partHeaders, partBody) {
    const ct = partHeaders['content-type'] || 'text/plain';
    const mime = ct.split(';')[0].trim().toLowerCase();
    const boundaryMatch = ct.match(/boundary="?([^";\r\n]+)"?/i);
    if (mime.startsWith('multipart/') && boundaryMatch) {
      const boundary = `--${boundaryMatch[1]}`;
      const segments = partBody.split(boundary);
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith('--')) break;
        const cleanSeg = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        const sIdx = cleanSeg.indexOf('\r\n\r\n') >= 0 ? cleanSeg.indexOf('\r\n\r\n') : cleanSeg.indexOf('\n\n');
        if (sIdx < 0) continue;
        const sLen = cleanSeg.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
        walkPart(parseHeadersBlock(cleanSeg.slice(0, sIdx)), cleanSeg.slice(sIdx + sLen));
      }
      return;
    }
    const disp = (partHeaders['content-disposition'] || '').toLowerCase();
    const transfer = (partHeaders['content-transfer-encoding'] || '').trim().toLowerCase();
    const cid = partHeaders['content-id'] ? partHeaders['content-id'].replace(/[<>]/g, '').trim() : null;
    const filename = decodeParamFilename(partHeaders['content-disposition'] || '') || decodeParamFilename(ct);
    if (disp.startsWith('attachment') || disp.startsWith('inline') || cid || (filename && mime !== 'text/plain' && mime !== 'text/html')) {
      let bytes;
      if (transfer === 'base64') {
        const bin = atob(partBody.replace(/[^A-Za-z0-9+/=]/g, ''));
        bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      } else {
        bytes = new TextEncoder().encode(partBody);
      }
      result.attachments.push({
        filename: filename || 'attachment',
        mimeType: mime,
        disposition: disp.startsWith('inline') ? 'inline' : 'attachment',
        contentId: cid,
        content: bytes
      });
      return;
    }
    let decodedText = partBody;
    if (transfer === 'base64') {
      try {
        const bin = atob(partBody.replace(/[^A-Za-z0-9+/=]/g, ''));
        decodedText = new TextDecoder('utf-8').decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      } catch {}
    }
    if (mime === 'text/html') result.html = decodedText;
    else if (mime === 'text/plain') result.text = decodedText;
  }

  walkPart(headers, bodyPart);
  return result;
}

export async function parseStoredMessage(env, storageKey) {
  const obj = await env.MAIL_STORAGE.get(storageKey);
  if (!obj) return null;
  const raw = await obj.arrayBuffer();
  const PostalMime = await getPostalMime();
  if (PostalMime) {
    try { return await new PostalMime().parse(raw); } catch {}
  }
  return parseMimeFallback(raw);
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

function encHeader(s='') { return String(s).replace(/[\r\n]+/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').trim(); }
function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out=''; const step=0x8000;
  for(let i=0;i<arr.length;i+=step) out += String.fromCharCode(...arr.subarray(i,i+step));
  return btoa(out);
}

function encodeHeaderText(value='') {
  const clean = encHeader(value);
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 70) return clean;
  const chunks = [];
  let current = [];
  for (const point of clean) {
    const bytes = new TextEncoder().encode(point);
    if (current.length && current.length + bytes.length > 42) { chunks.push(Uint8Array.from(current)); current = []; }
    current.push(...bytes);
  }
  if (current.length) chunks.push(Uint8Array.from(current));
  return chunks.map(bytes => `=?UTF-8?B?${toBase64(bytes)}?=`).join('\r\n ');
}
function foldAddressHeader(name, addresses) {
  const tokens = addresses.map(encHeader).filter(Boolean);
  let line = `${name}: `;
  const output = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = `${i ? ', ' : ''}${tokens[i]}`;
    if (line.length + token.length > 78 && line.length > name.length + 2) {
      output.push(line);
      // Keep the RFC address-list comma when folding to a continuation line.
      // Dropping it here would concatenate two recipients into one malformed address.
      line = ` ${i ? ', ' : ''}${tokens[i]}`;
    } else line += token;
  }
  if (line.trim()) output.push(line);
  return output.join('\r\n');
}

export async function buildMime({from,sender='',to,cc=[],bcc=[],subject='',text='',html='',attachments=[],inlineAttachments=[],inlineCidMap=[],messageId=null,inReplyTo=null,references=[],replyTo='',priority='normal',listUnsubscribe=''}) {
  const mixed=`sfm_mix_${crypto.randomUUID().replaceAll('-','')}`;
  const related=`sfm_related_${crypto.randomUUID().replaceAll('-','')}`;
  const alt=`sfm_alt_${crypto.randomUUID().replaceAll('-','')}`;
  const htmlBody=cleanEmailHtml(html || `<div>${String(text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div>`);
  const textBody=String(text||'').trim() || htmlBody.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
  const mid=encHeader(messageId || `<${crypto.randomUUID()}@mail.skyfirst.io.vn>`);
  const refs=(Array.isArray(references)?references:[]).map(encHeader).filter(Boolean);
  const lines=[
    `From: ${encHeader(from)}`,
    ...(sender&&sender!==from?[`Sender: ${encHeader(sender)}`]:[]),
    foldAddressHeader('To', to),
    ...(cc.length?[foldAddressHeader('Cc',cc)]:[]),
    `Subject: ${encodeHeaderText(subject || '(Không có tiêu đề)')}`,
    ...(replyTo?[`Reply-To: ${encHeader(replyTo)}`]:[]),
    ...(listUnsubscribe?[`List-Unsubscribe: <${encHeader(listUnsubscribe)}>`,'List-Unsubscribe-Post: List-Unsubscribe=One-Click']:[]),
    ...(priority==='high'?['X-Priority: 1','Importance: high']:priority==='low'?['X-Priority: 5','Importance: low']:[]),
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${mid}`,
    ...(inReplyTo?[`In-Reply-To: ${encHeader(inReplyTo)}`]:[]),
    ...(refs.length?[`References: ${refs.join(' ')}`]:[]),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`, '',
    `--${mixed}`,
    `Content-Type: multipart/related; boundary="${related}"; type="multipart/alternative"`, '',
    `--${related}`,
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
  const seenCids = new Set();
  for (let index=0; index<inlineAttachments.length; index++) {
    const a=inlineAttachments[index];
    const ab=await a.arrayBuffer();
    const b64=toBase64(ab).replace(/(.{76})/g,'$1\r\n');
    let cid=String(inlineCidMap[index]?.cid||'');
    if(!/^[-a-zA-Z0-9_.@]{1,127}$/.test(cid)||seenCids.has(cid))cid=`sfm-inline-${crypto.randomUUID()}`;
    seenCids.add(cid);
    const mime=safeMimeType(a.type),filename=safeMimeFilename(a.name||'inline-image');
    lines.push(`--${related}`,`Content-Type: ${mime}; name="${filename.ascii}"`,`Content-Disposition: inline; ${filename.parameters}`,`Content-ID: <${cid}>`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  lines.push(`--${related}--`,'');
  for (const a of attachments) {
    const ab=await a.arrayBuffer();
    const b64=toBase64(ab).replace(/(.{76})/g,'$1\r\n');
    const mime=safeMimeType(a.type),filename=safeMimeFilename(a.name||'attachment');
    lines.push(`--${mixed}`,`Content-Type: ${mime}; name="${filename.ascii}"`,`Content-Disposition: attachment; ${filename.parameters}`,'Content-Transfer-Encoding: base64','',b64,'');
  }
  lines.push(`--${mixed}--`,'');
  return new TextEncoder().encode(lines.join('\r\n')).buffer;
}
