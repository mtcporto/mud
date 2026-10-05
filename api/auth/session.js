import { getGoogleConfig, getGoogleSession, isAdminEmail } from '../../lib/google-auth.js';

function reply(res, status, body) {
  if (typeof res.status === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createGoogleSessionHandler({ env = process.env } = {}) {
  return function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return reply(res, 405, { error: 'Método não permitido.' });
    }
    const session = getGoogleSession(req, env);
    if (!session) {
      return reply(res, 200, {
        authenticated: false,
        isAdmin: false,
        configured: Boolean(getGoogleConfig(env)),
      });
    }
    return reply(res, 200, {
      authenticated: true,
      email: session.email,
      isAdmin: isAdminEmail(session.email),
      configured: true,
    });
  };
}

export default createGoogleSessionHandler();
