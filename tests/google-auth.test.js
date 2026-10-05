import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGoogleStartHandler } from '../api/auth/google/start.js';
import { createGoogleCallbackHandler } from '../api/auth/google/callback.js';
import { createGoogleLogoutHandler } from '../api/auth/logout.js';
import { createGoogleSessionHandler } from '../api/auth/session.js';
import {
  createGoogleSessionCookie, getAppOrigin, getGoogleSession, isAdminEmail,
  GOOGLE_SESSION_COOKIE, verifyGoogleSessionCookie,
} from '../lib/google-auth.js';

const SECRET = 'google-secret-for-tests';
const ENV = {
  APP_URL: 'https://mud-indol.vercel.app',
  GOOGLE_CLIENT_ID: 'mud-client-id',
  GOOGLE_CLIENT_SECRET: SECRET,
  NODE_ENV: 'production',
};

function responseMock() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body = '') { this.body = body; },
  };
}

test('Google OAuth config only accepts an HTTPS app origin (or local HTTP outside production)', () => {
  assert.equal(getAppOrigin(ENV), 'https://mud-indol.vercel.app');
  assert.equal(getAppOrigin({ APP_URL: 'https://mud-indol.vercel.app/path' }), null);
  assert.equal(getAppOrigin({ APP_URL: 'http://mud-indol.vercel.app' }), null);
  assert.equal(getAppOrigin({ APP_URL: 'http://127.0.0.1:3000', NODE_ENV: 'development' }), 'http://127.0.0.1:3000');
  assert.equal(getAppOrigin({ APP_URL: 'http://127.0.0.1:3000', NODE_ENV: 'production' }), null);
});

test('Google session cookies are signed, expire, and grant admin only to the verified admin email', () => {
  const now = 1_800_000_000;
  const token = createGoogleSessionCookie('MTCporto@gmail.com', 'google-subject', SECRET, now);
  assert.deepEqual(verifyGoogleSessionCookie(token, SECRET, now + 60), {
    email: 'mtcporto@gmail.com',
    subject: 'google-subject',
  });
  assert.equal(verifyGoogleSessionCookie(token, 'wrong-secret', now), null);
  assert.equal(verifyGoogleSessionCookie(`${token.slice(0, -1)}x`, SECRET, now), null);
  assert.equal(verifyGoogleSessionCookie(token, SECRET, now + 7 * 24 * 60 * 60), null);
  assert.equal(isAdminEmail('MTCporto@gmail.com'), true);
  assert.equal(isAdminEmail('mtcporto@gmail.com.evil.example'), false);

  const cookie = `${GOOGLE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
  assert.deepEqual(getGoogleSession({ headers: { cookie } }, { GOOGLE_CLIENT_SECRET: SECRET }, now), {
    email: 'mtcporto@gmail.com',
    subject: 'google-subject',
  });
});

test('Google login redirects with state, nonce, and a PKCE verifier in a protected cookie', () => {
  const handler = createGoogleStartHandler({ env: ENV });
  const res = responseMock();
  handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 302);
  const authorization = new URL(res.headers.Location);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('client_id'), ENV.GOOGLE_CLIENT_ID);
  assert.equal(authorization.searchParams.get('redirect_uri'), `${ENV.APP_URL}/api/auth/google/callback`);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('state').length, 43);
  assert.equal(authorization.searchParams.get('nonce').length, 43);

  const stateCookie = res.headers['Set-Cookie'];
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /Secure/);
  assert.match(stateCookie, /SameSite=Lax/);
  const encodedState = stateCookie.match(/^mud_google_state=([^;]+)/)?.[1];
  const saved = JSON.parse(Buffer.from(decodeURIComponent(encodedState), 'base64url').toString('utf8'));
  assert.equal(saved.state, authorization.searchParams.get('state'));
  assert.equal(saved.nonce, authorization.searchParams.get('nonce'));
  assert.equal(createHash('sha256').update(saved.verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
});

test('Google callback rejects a missing or mismatched state without exchanging a code', async () => {
  let exchanges = 0;
  const handler = createGoogleCallbackHandler({
    env: ENV,
    fetchImpl: async () => { exchanges += 1; throw new Error('Unexpected token exchange'); },
  });
  const res = responseMock();
  await handler({
    method: 'GET',
    headers: {},
    query: { code: 'authorization-code', state: 'untrusted-state' },
  }, res);

  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /auth_error=invalid_state/);
  assert.equal(exchanges, 0);
  assert.match(res.headers['Set-Cookie'][0], /Max-Age=0/);
});

test('session endpoint reports verified admin status and logout enforces same-origin requests', () => {
  const sessionHandler = createGoogleSessionHandler({ env: ENV });
  const cookieValue = createGoogleSessionCookie('mtcporto@gmail.com', 'google-subject', SECRET);
  const sessionResponse = {
    ...responseMock(),
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; },
  };
  sessionHandler({
    method: 'GET',
    headers: { cookie: `${GOOGLE_SESSION_COOKIE}=${encodeURIComponent(cookieValue)}` },
  }, sessionResponse);
  assert.equal(sessionResponse.statusCode, 200);
  assert.deepEqual(sessionResponse.body, {
    authenticated: true,
    email: 'mtcporto@gmail.com',
    isAdmin: true,
    configured: true,
  });

  const logoutHandler = createGoogleLogoutHandler({ env: ENV });
  const blockedLogout = {
    ...responseMock(),
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; },
  };
  logoutHandler({ method: 'POST', headers: { origin: 'https://attacker.example' } }, blockedLogout);
  assert.equal(blockedLogout.statusCode, 403);
  assert.equal(blockedLogout.headers['Set-Cookie'], undefined);

  const logoutResponse = {
    ...responseMock(),
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; },
  };
  logoutHandler({ method: 'POST', headers: { origin: ENV.APP_URL } }, logoutResponse);
  assert.equal(logoutResponse.statusCode, 200);
  assert.equal(logoutResponse.body.loggedOut, true);
  assert.match(logoutResponse.headers['Set-Cookie'], /Max-Age=0/);
  assert.match(logoutResponse.headers['Set-Cookie'], /HttpOnly/);
});
