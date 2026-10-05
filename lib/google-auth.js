import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const GOOGLE_STATE_COOKIE = 'mud_google_state';
export const GOOGLE_SESSION_COOKIE = 'mud_google_session';
export const ADMIN_EMAIL = 'mtcporto@gmail.com';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function getAppOrigin(env = process.env) {
  if (!env.APP_URL) return null;
  try {
    const url = new URL(env.APP_URL);
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost && env.NODE_ENV !== 'production')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getGoogleConfig(env = process.env) {
  const origin = getAppOrigin(env);
  if (!origin || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    origin,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${origin}/api/auth/google/callback`,
  };
}

export function isAdminEmail(email) {
  return typeof email === 'string' && email.trim().toLowerCase() === ADMIN_EMAIL;
}

export function createGoogleSessionCookie(email, subject, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof email !== 'string' || !email.trim() || typeof subject !== 'string' || !subject || !secret) {
    throw new TypeError('Google session requires a verified email, subject, and signing secret.');
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    email: email.trim().toLowerCase(),
    subject,
    issuedAt: now,
    expiresAt: now + SESSION_SECONDS,
  })).toString('base64url');
  const signature = createHmac('sha256', `mud-google-session:${secret}`)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyGoogleSessionCookie(cookie, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof cookie !== 'string' || !secret) return null;
  const [payload, signature, extra] = cookie.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', `mud-google-session:${secret}`)
    .update(payload)
    .digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.version !== 1
      || typeof session.email !== 'string'
      || typeof session.subject !== 'string'
      || !session.subject
      || !Number.isInteger(session.issuedAt)
      || !Number.isInteger(session.expiresAt)
      || session.issuedAt > now + 60
      || session.expiresAt <= now
      || session.expiresAt - session.issuedAt > SESSION_SECONDS) return null;
    return { email: session.email, subject: session.subject };
  } catch {
    return null;
  }
}

export function getGoogleSession(request, env = process.env, now) {
  const secret = env.GOOGLE_CLIENT_SECRET;
  const cookieHeader = request?.headers?.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== GOOGLE_SESSION_COOKIE) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
    return verifyGoogleSessionCookie(value, secret, now);
  }
  return null;
}

export function parseCookie(request, name) {
  const cookieHeader = request?.headers?.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeCookie(name, value, { maxAge, path = '/', secure = true } = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function createOAuthParameters() {
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, nonce, verifier, challenge };
}

export async function verifyGoogleIdentity(idToken, clientId, expectedNonce) {
  const { payload } = await jwtVerify(idToken, googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'],
  });
  if (payload.nonce !== expectedNonce) throw new Error('Google identity nonce did not match.');
  if (payload.email_verified !== true || typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
    throw new Error('Google identity must contain a verified email and subject.');
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
    throw new Error('Google identity authorized party did not match.');
  }
  const email = payload.email.trim().toLowerCase();
  if (!email.endsWith('@gmail.com') && typeof payload.hd !== 'string') {
    throw new Error('Google Workspace identity is missing its hosted domain.');
  }
  return { email, subject: payload.sub };
}

function randomValue() {
  return randomBytes(32).toString('base64url');
}
