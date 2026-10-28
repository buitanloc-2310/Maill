function wellFormedFilename(value) {
  const input = String(value ?? 'attachment');
  if (typeof input.toWellFormed === 'function') return input.toWellFormed();
  let output = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (i + 1 < input.length && next >= 0xdc00 && next <= 0xdfff) output += input[i] + input[++i];
      else output += '\uFFFD';
    } else if (code >= 0xdc00 && code <= 0xdfff) output += '\uFFFD';
    else output += input[i];
  }
  return output;
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (Array.isArray(content)) return Uint8Array.from(content);
  return new Uint8Array();
}

export function safeMimeType(value) {
  const candidate = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate)
    ? candidate
    : 'application/octet-stream';
}

export function safeMimeFilename(value) {
  const name = (wellFormedFilename(value || 'attachment')
    .replace(/[\\/";\r\n\x00-\x1f\x7f]/g, '_').replace(/\.\./g, '_').slice(0, 180) || 'attachment');
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/[";\\]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return { ascii, parameters: `filename="${ascii}"; filename*=UTF-8''${encoded}` };
}

const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
  '.exe', '.scr', '.bat', '.cmd', '.com', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.ps1', '.psm1', '.msi', '.msp', '.hta', '.cpl', '.jar', '.reg', '.dll', '.pif', '.lnk'
]);

export function isDangerousAttachmentName(filename = '') {
  const lower = String(filename || '').trim().toLowerCase();
  for (const ext of BLOCKED_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext) || new RegExp(`\\${ext}\\.[a-z0-9]{1,8}$`, 'i').test(lower)) return true;
  }
  return false;
}

export function isAllowedAvatarImage(type, bytes) {
  const normalized = String(type || '').split(';')[0].trim().toLowerCase();
  const data = toBytes(bytes);
  if (normalized === 'image/png') return data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => data[i] === value);
  if (normalized === 'image/jpeg') return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (normalized === 'image/gif') return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...data.subarray(0, 6)));
  if (normalized === 'image/webp') return data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP';
  return false;
}

export function safeAttachmentResponse(attachment, inlineRequested = false) {
  const bytes = toBytes(attachment?.content);
  const mime = String(attachment?.mimeType || '').split(';')[0].trim().toLowerCase();
  const inlineType = inlineRequested && isAllowedAvatarImage(mime, bytes) ? mime : null;
  const filename = (wellFormedFilename(attachment?.filename || 'attachment')
    .replace(/[\\/";\r\n\x00-\x1f\x7f]/g, '_').replace(/\.\./g, '_').slice(0, 180) || 'attachment');
  const asciiFilename = filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/[";\\]/g, '_') || 'attachment';
  const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(bytes, { headers: {
    'content-type': inlineType || 'application/octet-stream',
    'content-disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
    'cache-control': 'private,no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox; object-src 'none'; base-uri 'none'",
    'cross-origin-resource-policy': 'same-origin'
  }});
}
