const encoder = new TextEncoder();

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

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, saltB64 = null, iterations = 100000) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const normalizedIterations = Math.min(100000, Math.max(10000, Number(iterations || 100000))); // Cloudflare Workers currently caps PBKDF2 at 100,000
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
    const digest = await crypto.subtle.digest('SHA-256', combined);
    actual = `sha256$${bytesToBase64(new Uint8Array(digest))}`;
  } else {
    const wanted = raw.startsWith('pbkdf2$') ? raw : `pbkdf2$${raw}`;
    const result = await hashPassword(password, salt, Number(iterations || 100000));
    actual = result.hash.startsWith('pbkdf2$') ? result.hash : result.hash;
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
