import {
  getAppOrigin, GOOGLE_SESSION_COOKIE, serializeCookie,
} from '../../lib/google-auth.js';

function reply(res, status, body) {
  if (typeof res.status === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createGoogleLogoutHandler({ env = process.env } = {}) {
  return function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'Método não permitido.' });
    }
    const origin = getAppOrigin(env);
    if (!origin) return reply(res, 503, { error: 'APP_URL não está configurada para o logout.' });
    if (req.headers.origin !== origin) return reply(res, 403, { error: 'Origem não permitida.' });
    res.setHeader('Set-Cookie', serializeCookie(GOOGLE_SESSION_COOKIE, '', {
      maxAge: 0,
      secure: origin.startsWith('https://'),
    }));
    return reply(res, 200, { loggedOut: true });
  };
}

export default createGoogleLogoutHandler();
