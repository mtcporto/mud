import {
  buildAgentContext, isSafeAutonomousCommand, requestGemmaDecision,
} from '../lib/agent-autonomy.js';
import { getGoogleSession, isAdminEmail } from '../lib/google-auth.js';
import { isProfileId } from '../lib/profile.js';
import { tursoStore } from '../lib/turso.js';

const ALLOWED_ORIGINS = new Set([
  'https://mud-indol.vercel.app',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);
const MIN_REQUEST_INTERVAL_MS = 4000;
const recentRequests = new Map();

function respond(res, status, body) {
  return res.status(status).json(body);
}

function allowedRequest(requester, now = Date.now()) {
  const previous = recentRequests.get(requester);
  if (previous !== undefined && now - previous < MIN_REQUEST_INTERVAL_MS) return false;
  if (recentRequests.size > 5000) {
    for (const [key, timestamp] of recentRequests) {
      if (now - timestamp >= MIN_REQUEST_INTERVAL_MS) recentRequests.delete(key);
    }
  }
  recentRequests.set(requester, now);
  return true;
}

export function createAgentDecisionHandler({
  fetchImpl = fetch,
  getKnowledge = profile => tursoStore(process.env).get(profile),
  env = process.env,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return respond(res, 403, { error: 'Origem não permitida.' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respond(res, 405, { error: 'Método não permitido.' });
    }
    const session = getGoogleSession(req, env);
    if (!session) return respond(res, 401, { error: 'Entre com o Google para controlar o agente.' });
    if (!isAdminEmail(session.email)) return respond(res, 403, { error: 'Somente a conta administradora pode controlar Luna.' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return respond(res, 415, { error: 'Envie JSON.' });
    }
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.profile !== 'string' || !isProfileId(input.profile)
      || typeof input.context !== 'string' || !input.context.trim() || input.context.length > 12000) {
      return respond(res, 400, { error: 'Estado atual do agente inválido.' });
    }
    if (!env.OLLAMA_API_KEY) {
      return respond(res, 503, { error: 'OLLAMA_API_KEY não está configurada no servidor.' });
    }
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const requester = forwardedFor || req.socket?.remoteAddress || input.profile;
    if (!allowedRequest(String(requester))) {
      res.setHeader('Retry-After', '4');
      return respond(res, 429, { error: 'Aguarde antes da próxima decisão do agente.' });
    }

    let knowledge;
    try {
      knowledge = await getKnowledge(input.profile);
    } catch {
      return respond(res, 503, { error: 'Banco de conhecimento indisponível.' });
    }
    const context = buildAgentContext({
      knowledge,
      history: input.context,
      goal: 'Jogar Luna em direção ao nível 10 enquanto aprende e documenta o mundo do MUD.',
    });
    try {
      const decision = await requestGemmaDecision({
        context,
        fetchImpl,
        apiKey: env.OLLAMA_API_KEY,
        baseUrl: env.OLLAMA_BASE_URL || 'https://ollama.com/v1',
        model: env.OLLAMA_MODEL || 'gemma4:31b',
      });
      if (!isSafeAutonomousCommand(decision.command)) {
        return respond(res, 502, { error: 'Gemma sugeriu um comando que não pode ser executado.' });
      }
      return respond(res, 200, decision);
    } catch (error) {
      const isRateLimited = error instanceof Error && /HTTP 429/.test(error.message);
      return respond(res, isRateLimited ? 429 : 502, {
        error: isRateLimited ? 'Ollama aplicou limite temporário; o agente foi pausado.' : 'Não foi possível obter a decisão do agente.',
      });
    }
  };
}

export default createAgentDecisionHandler();
