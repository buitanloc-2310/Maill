import { cookie, clearCookie, getCookie, randomToken, sha256Hex } from './security.js';

export async function createSession(env, userId, request = null) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const ip = request?.headers?.get('CF-Connecting-IP') || null;
  const ua = request?.headers?.get('User-Agent') || null;
  try {
    await env.DB.prepare(`INSERT INTO sessions(user_id, token_hash, expires_at, ip, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(userId, tokenHash, expires, ip, ua).run();
  } catch {
    await env.DB.prepare(`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (?, ?, ?)`)
      .bind(userId, tokenHash, expires).run();
  }
  return { token, header: cookie('sfm_session', token), expires };
}

export async function currentSession(request, env) {
  const token = getCookie(request, 'sfm_session');
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT s.id session_id, s.expires_at session_expires_at, u.*
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active' LIMIT 1
  `).bind(tokenHash).first();
  if (row) {
    try { await env.DB.prepare(`UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.session_id).run(); } catch {}
  }
  return row;
}

export async function currentUser(request, env) { return currentSession(request, env); }

export async function destroySession(request, env) {
  const token = getCookie(request, 'sfm_session');
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(tokenHash).run();
  }
  return clearCookie('sfm_session');
}

export function isAdmin(user) { return !!user && ['admin','super_admin'].includes(user.role); }
