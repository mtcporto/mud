import {
  createGoogleSessionCookie, getGoogleConfig, GOOGLE_SESSION_COOKIE, GOOGLE_STATE_COOKIE,
  parseCookie, serializeCookie, verifyGoogleIdentity,
} from '../../../lib/google-auth.js';

function clearStateCookie(secure) {
  return serializeCookie(GOOGLE_STATE_COOKIE, '', { maxAge: 0, path: '/api/auth/google', secure });
}

function redirect(res, url, cookies = []) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

function errorRedirect(origin, reason) {
  const target = new URL('/', origin);
  target.searchParams.set('auth_error', reason);
  return target.toString();
}

export function createGoogleCallbackHandler({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return async function handler(req, res) {
    const config = getGoogleConfig(env);
    const origin = config?.origin;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.statusCode = 405;
      return res.end('Método não permitido.');
    }
    if (!config) {
      res.statusCode = 503;
      return res.end('Login Google não está configurado para este aplicativo.');
    }

    const clearCookie = clearStateCookie(origin.startsWith('https://'));
    const stateValue = parseCookie(req, GOOGLE_STATE_COOKIE);
    const query = req.query || Object.fromEntries(new URL(req.url, origin).searchParams);
    let savedState;
    try {
      savedState = stateValue ? JSON.parse(Buffer.from(stateValue, 'base64url').toString('utf8')) : null;
    } catch {
      savedState = null;
    }
    if (!savedState || typeof savedState.state !== 'string'
      || typeof savedState.nonce !== 'string' || typeof savedState.verifier !== 'string'
      || !query.state || query.state !== savedState.state) {
      return redirect(res, errorRedirect(origin, 'invalid_state'), [clearCookie]);
    }
    if (query.error || typeof query.code !== 'string' || !query.code) {
      return redirect(res, errorRedirect(origin, 'cancelled'), [clearCookie]);
    }

    let tokenResponse;
    try {
      tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: query.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: savedState.verifier,
        }),
      });
    } catch {
      return redirect(res, errorRedirect(origin, 'oauth_unavailable'), [clearCookie]);
    }
    if (!tokenResponse.ok) {
      return redirect(res, errorRedirect(origin, 'token_exchange'), [clearCookie]);
    }
    let tokens;
    try {
      tokens = await tokenResponse.json();
    } catch {
      return redirect(res, errorRedirect(origin, 'invalid_identity'), [clearCookie]);
    }
    if (typeof tokens.id_token !== 'string') {
      return redirect(res, errorRedirect(origin, 'invalid_identity'), [clearCookie]);
    }
    let identity;
    try {
      identity = await verifyGoogleIdentity(tokens.id_token, config.clientId, savedState.nonce);
    } catch {
      return redirect(res, errorRedirect(origin, 'identity_verification'), [clearCookie]);
    }
    const sessionCookie = createGoogleSessionCookie(identity.email, identity.subject, config.clientSecret);
    const session = serializeCookie(GOOGLE_SESSION_COOKIE, sessionCookie, {
      maxAge: 7 * 24 * 60 * 60,
      secure: origin.startsWith('https://'),
    });
    return redirect(res, `${origin}/?auth=success`, [clearCookie, session]);
  };
}

export default createGoogleCallbackHandler();
