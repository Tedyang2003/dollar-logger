/* Web Push, implemented with WebCrypto (Node's web-push library does not run
 * in Workers).
 *
 * Two separate pieces of crypto, easy to confuse:
 *  - VAPID (RFC 8292): a JWT signed with OUR key, proving to Apple/Google's
 *    push service that this server is allowed to message this subscription.
 *  - Payload encryption (RFC 8291): the message is encrypted to the PHONE's
 *    key, so the push service relaying it cannot read your spending.
 */

const enc = new TextEncoder();

function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  let t = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), c => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF-Expand for a single block, which is all RFC 8291 needs (<= 32 bytes).
async function expand(prk, info, len) {
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/* ---------------- RFC 8291 payload encryption ---------------- */

export async function encryptPayload(payload, p256dhB64, authB64, testOverrides) {
  const uaPublic = unb64u(p256dhB64);         // phone's public key, 65 bytes
  const authSecret = unb64u(authB64);         // phone's 16-byte secret

  const as = testOverrides && testOverrides.keyPair ||
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await expand(prkKey, keyInfo, 32);

  const salt = testOverrides && testOverrides.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await expand(prk, enc.encode('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the final (and only) record.
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);   // record size
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, cipher);
}

/* ---------------- RFC 8292 VAPID ---------------- */

async function vapidAuth(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT
  })));
  // WebCrypto ECDSA signatures are already raw r||s, which is what JWT wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + env.VAPID_PUBLIC_KEY;
}

/* ---------------- sending ---------------- */

export async function sendPush(env, sub, message) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal'
    },
    body
  });
  // 404/410: the phone unsubscribed or the app was removed. Forget it.
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
  } else if (!res.ok) {
    console.warn('push failed', res.status, (await res.text()).slice(0, 200));
  }
  return res.status;
}

export async function notifyUser(env, userId, message) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return 0;
  const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
  let sent = 0;
  for (const s of results || []) {
    try { if ((await sendPush(env, s, message)) < 300) sent++; } catch (e) { console.warn('push error', e && e.message); }
  }
  return sent;
}
