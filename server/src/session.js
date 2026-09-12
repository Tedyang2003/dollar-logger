/* App sessions.
 *
 * A Google ID token proves identity once, then expires in about an hour and
 * cannot be renewed silently on iOS Safari. That is fine for an optional sync
 * and useless as a login. So we trade it, exactly once, for a token this server
 * signs itself: valid for 30 days, revocable, and good offline.
 *
 * These are HS256 (symmetric) JWTs. That is the right choice here and the wrong
 * choice for Google: symmetric means whoever can verify can also forge, which
 * is fine when the only verifier is the same server that signed it. Google must
 * use RS256 because thousands of unrelated servers verify its tokens and none
 * of them may be able to mint one.
 */

const SESSION_DAYS = 30;

export class SessionError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function secret(env) {
  const s = env.SESSION_SECRET;
  // Fail closed. A default signing key would mean anyone who read this source
  // could mint sessions for any account.
  if (!s || s.length < 32) throw new SessionError('server_missing_session_secret');
  return s;
}

async function hmacKey(env) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function issueSession(user, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.sub,
    email: user.email || null,
    iat: now,
    exp: now + SESSION_DAYS * 86400
  };

  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));

  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head + '.' + body));

  return {
    token: head + '.' + body + '.' + b64urlBytes(new Uint8Array(sig)),
    expires_at: payload.exp
  };
}

export async function verifySession(token, env, db) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new SessionError('malformed');

  let header, payload;
  try {
    header = JSON.parse(fromB64url(parts[0]));
    payload = JSON.parse(fromB64url(parts[1]));
  } catch (e) {
    throw new SessionError('malformed');
  }

  // Pin the algorithm, same reasoning as the Google token: never let the token
  // tell you how to check it.
  if (header.alg !== 'HS256') throw new SessionError('unexpected_alg');

  const key = await hmacKey(env);
  const ok = await crypto.subtle.verify(
    'HMAC', key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!ok) throw new SessionError('bad_signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new SessionError('expired');
  if (!payload.sub) throw new SessionError('no_subject');

  /* Revocation. A signed token is valid until it expires, which means signing
     out would otherwise do nothing at all - the token keeps working for 30 days
     on whatever device holds it. Each user carries a cutoff timestamp; signing
     out everywhere moves it to now, and every token issued before it dies. */
  const row = await db.prepare(
    'SELECT sessions_valid_from FROM users WHERE id = ?'
  ).bind(payload.sub).first();

  if (row && row.sessions_valid_from) {
    if (Number(payload.iat || 0) < Number(row.sessions_valid_from)) {
      throw new SessionError('revoked');
    }
  }

  return { sub: payload.sub, email: payload.email || null };
}

export async function revokeSessions(userId, db) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('UPDATE users SET sessions_valid_from = ? WHERE id = ?')
    .bind(now, userId)
    .run();
}

/* ---------------- base64url ---------------- */

function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromB64url(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}
