const encoder = new TextEncoder();

export const RELIABILITY_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS send_operations (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preparing',storage_key TEXT,provider_id TEXT,response_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id))",
  "CREATE INDEX IF NOT EXISTS idx_send_operations_user ON send_operations(user_id,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,window_start INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inbound_receipts (mailbox_id INTEGER NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(mailbox_id,digest))"
];

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToBase64(arr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value) {
  return digest(encoder.encode(value));
}

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(message || '')));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(form) {
  const parts = [];
  for (const [key, value] of form.entries()) {
    if (key === 'requestId') continue;
    if (typeof value === 'string') parts.push([key, value]);
    else parts.push([key, value.name, value.type, await digest(await value.arrayBuffer())]);
  }
  parts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest(encoder.encode(JSON.stringify(parts)));
}

export async function boundedRequest(request, maxBytes) {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) throw Object.assign(new Error('Yêu cầu quá lớn.'), { status: 413 });
  const reader = request.body?.getReader(); if (!reader) return request;
  const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) throw Object.assign(new Error('Yêu cầu quá lớn.'), { status: 413 }); chunks.push(value); }
  } catch (error) { try { await reader.cancel(error); } catch {} throw error; }
  finally { try { reader.releaseLock(); } catch {} }
  const data = new Uint8Array(size); let at = 0; for (const c of chunks) { data.set(c, at); at += c.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body: data });
}

export async function readStreamBounded(stream, maxBytes) {
  if (!stream || typeof stream.getReader !== 'function') throw new TypeError('ReadableStream required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative safe integer.');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Stream chunks must be Uint8Array.');
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('Stream exceeded configured size limit.').catch(() => {});
        throw Object.assign(new Error('Stream exceeds size limit.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function secureResponse(response) {
  const h = new Headers(response.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, headers: h });
}

export async function hashPassword(password, saltB64 = null, iterations = 100000) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const normalizedIterations = Math.min(100000, Math.max(10000, Number(iterations || 100000)));
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: normalizedIterations }, key, 256);
    return { salt: bytesToBase64(salt), hash: `pbkdf2$${bytesToBase64(new Uint8Array(bits))}`, iterations: normalizedIterations };
  } catch (e) {
    console.error('PBKDF2_HASH_FAILED', {
      requestedIterations: Number(iterations || 100000),
      normalizedIterations,
      message: e?.message || String(e)
    });
    throw e;
  }
}

export async function verifyPassword(password, salt, expectedHash, iterations) {
  const raw = String(expectedHash || '');
  let actual = '';
  if (raw.startsWith('sha256$')) {
    const saltBytes = base64ToBytes(salt);
    const pw = encoder.encode(password);
    const combined = new Uint8Array(saltBytes.length + pw.length);
    combined.set(saltBytes, 0);
    combined.set(pw, saltBytes.length);
    const d = await crypto.subtle.digest('SHA-256', combined);
    actual = `sha256$${bytesToBase64(new Uint8Array(d))}`;
  } else {
    const wanted = raw.startsWith('pbkdf2$') ? raw : `pbkdf2$${raw}`;
    const result = await hashPassword(password, salt, Number(iterations || 100000));
    actual = result.hash;
    if (!raw.includes('$')) expectedHash = wanted;
  }
  const a = encoder.encode(actual);
  const b = encoder.encode(String(expectedHash || ''));
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export function cookie(name, value, maxAge = 60 * 60 * 24 * 14) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
