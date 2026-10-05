import {
  createOAuthParameters, getGoogleConfig, GOOGLE_STATE_COOKIE, serializeCookie,
} from '../../../lib/google-auth.js';

function reply(res, status, body) {
  if (typeof res.status === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createGoogleStartHandler({ env = process.env } = {}) {
  return function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return reply(res, 405, { error: 'Método não permitido.' });
    }
    const config = getGoogleConfig(env);
    if (!config) return reply(res, 503, { error: 'Login Google não está configurado para este aplicativo.' });

    const { state, nonce, verifier, challenge } = createOAuthParameters();
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'online',
    }).toString();
    const stateValue = Buffer.from(JSON.stringify({ state, nonce, verifier })).toString('base64url');
    const secure = config.origin.startsWith('https://');
    res.setHeader('Set-Cookie', serializeCookie(GOOGLE_STATE_COOKIE, stateValue, {
      maxAge: 600,
      path: '/api/auth/google',
      secure,
    }));
    res.statusCode = 302;
    res.setHeader('Location', authorization.toString());
    return res.end();
  };
}

export default createGoogleStartHandler();
