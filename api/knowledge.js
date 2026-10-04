import { parseObservation } from '../lib/observations.js';
import { isProfileId } from '../lib/profile.js';
import { tursoStore } from '../lib/turso.js';

const ALLOWED_ORIGINS = new Set([
  'https://mud-indol.vercel.app',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

function respond(res, status, body) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(res, 403, { error: 'Origem não permitida.' });

  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return respond(res, 405, { error: 'Método não permitido.' });
  }
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return respond(res, 415, { error: 'Envie JSON.' });
  }
  const profile = req.method === 'POST' ? req.body?.profile : req.query.profile;
  if (!isProfileId(profile)) return respond(res, 400, { error: 'Perfil inválido.' });

  let observation;
  if (req.method === 'POST') {
    const { command, text } = req.body || {};
    if (typeof command !== 'string' || command.length > 100 || typeof text !== 'string' || text.length > 12000) {
      return respond(res, 400, { error: 'Observação inválida.' });
    }
    observation = parseObservation(command, text);
    if (!observation) return respond(res, 400, { error: 'Comando não reconhecido.' });
  }

  try {
    const store = tursoStore(process.env);
    if (req.method === 'GET') return respond(res, 200, await store.get(profile));
    if (req.method === 'DELETE') {
      await store.clear(profile);
      return respond(res, 200, { cleared: true });
    }
    await store.save(profile, observation.command, text);
    return respond(res, 201, { saved: true });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
        .replace(/(?:libsql|https?):\/\/[^\s'"]+/gi, '[redacted-url]')
        .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
      : 'Unknown error';
    console.error('Turso knowledge API failed.', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      message,
    });
    return respond(res, 503, { error: 'Banco de conhecimento indisponível.' });
  }
}
