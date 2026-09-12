/* Verifying Google ID tokens.
 *
 * The client sends a JWT that Google signed. Anyone can read a JWT - it is
 * base64, not encryption - so decoding it proves nothing. What makes it
 * trustworthy is checking Google's signature against Google's public keys, and
 * then checking the claims inside say what we require.
 *
 * An ID token is not an access token. An ID token answers "who is this person,
 * to YOUR app" and is bound to your client id. An access token answers "what
 * may the bearer do to Google's APIs" and is not bound to you at all - using
 * one for sign-in is a real vulnerability, not a style choice.
 */

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CLOCK_SKEW_SEC = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

/* Module scope is the RIGHT place for this, unlike request state: Google's
   public keys are the same for every caller and are meant to be cached. The
   rule is not "never use module scope", it is "never put one request's data
   there". */
let jwksCache = { url: '', keys: null, fetchedAt: 0 };

export class AuthError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/* The JWKS URL decides which keys can mint valid identities, so an override is
   the most dangerous setting in this file: point it at a host someone else
   controls and they can sign themselves in as anyone. It exists only so tests
   can run real signature verification, and it is therefore honoured ONLY for
   loopback addresses. In production the variable is inert even if it is set. */
/* Exposed on /health so "am I verifying against Google or a test server?" is a
   question you can answer in one request instead of guessing. Returns a boolean
   only - never the URL. In production this is always false, by construction. */
export function usingTestKeys(env) {
  return resolveJwksUrl(env) !== DEFAULT_JWKS_URL;
}

function resolveJwksUrl(env) {
  const override = String(env.GOOGLE_JWKS_URL || '').trim();
  if (!override) return DEFAULT_JWKS_URL;

  let host;
  try {
    host = new URL(override).hostname;
  } catch (e) {
    return DEFAULT_JWKS_URL;
  }

  const loopback = (host === '127.0.0.1' || host === 'localhost' || host === '::1');
  if (!loopback) {
    console.error('SECURITY: ignoring non-loopback GOOGLE_JWKS_URL', override);
    return DEFAULT_JWKS_URL;
  }
  return override;
}

async function getJwks(url, forceRefresh) {
  const now = Date.now();
  const fresh = jwksCache.keys &&
                jwksCache.url === url &&
                (now - jwksCache.fetchedAt) < JWKS_TTL_MS;

  if (fresh && !forceRefresh) return jwksCache.keys;

  const res = await fetch(url);
  if (!res.ok) throw new AuthError('jwks_unavailable');

  const body = await res.json();
  jwksCache = { url: url, keys: body.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

/* Returns { sub, email } on success, throws AuthError otherwise. */
export async function verifyGoogleIdToken(token, env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new AuthError('server_missing_client_id');

  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed');

  let header, payload;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch (e) {
    throw new AuthError('malformed');
  }

  /* Pin the algorithm. A JWT names its own algorithm in the header, so a token
     claiming alg:"none" (no signature) or alg:"HS256" (symmetric, verified with
     a key an attacker may know) must be rejected outright rather than obeyed.
     Trusting the header's choice is the classic JWT algorithm-confusion bug. */
  if (header.alg !== 'RS256') throw new AuthError('unexpected_alg');

  const jwksUrl = resolveJwksUrl(env);

  let keys = await getJwks(jwksUrl, false);
  let jwk = keys.find(k => k.kid === header.kid);

  // Google rotates keys. An unknown kid is usually a stale cache, not an attack.
  if (!jwk) {
    keys = await getJwks(jwksUrl, true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) throw new AuthError('unknown_key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const signature = b64urlToBytes(parts[2]);

  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, signature, signed
  );
  if (!validSignature) throw new AuthError('bad_signature');

  // Signature is good - the token is genuinely Google's. Now: is it for US?
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < now) {
    throw new AuthError('expired');
  }
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_SEC > now) {
    throw new AuthError('issued_in_future');
  }
  if (GOOGLE_ISSUERS.indexOf(payload.iss) === -1) {
    throw new AuthError('bad_issuer');
  }

  /* The check people skip, and the one that matters most. Google signs ID
     tokens for every app using Google sign-in. Without this, a token issued to
     ANY other Google app could be replayed against yours and would verify
     perfectly - a valid signature that was never meant for you. */
  if (payload.aud !== clientId) {
    throw new AuthError('bad_audience');
  }

  if (!payload.sub) throw new AuthError('no_subject');

  /* Optional allowlist, so a personal app does not quietly become a free
     expense tracker for the internet. Unset means anyone with a Google
     account may sign in and gets their own separate data. */
  const allowed = String(env.ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (allowed.length) {
    const email = String(payload.email || '').toLowerCase();
    // An unverified email must not satisfy an allowlist - anyone can claim one.
    if (!payload.email_verified || allowed.indexOf(email) === -1) {
      throw new AuthError('not_allowed');
    }
  }

  return {
    sub: payload.sub,                 // stable, unique, and never reassigned
    email: payload.email || null
  };
}

/* ---------------- base64url ---------------- */

function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}
