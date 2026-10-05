import { isProfileId } from '../lib/profile.js';
import { suggestCommand } from '../lib/copilot.js';
import { tursoStore } from '../lib/turso.js';

const ALLOWED_ORIGINS = new Set([
  'https://mud-indol.vercel.app',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

function respond(res, status, body) {
  return res.status(status).json(body);
}

function knowledgeContext(knowledge) {
  const observations = Array.isArray(knowledge.observations) ? knowledge.observations : [];
  const characterCreation = knowledge.characterCreation || {};
  const summary = {
    profile: knowledge.profile,
    characterCreation: {
      build: characterCreation.build,
      selectedSkills: (characterCreation.skillChoices || []).filter(choice => choice.state !== 'available'),
    },
    equipmentAnalysis: knowledge.equipmentAnalysis,
    activeEffects: knowledge.activeEffects,
    scoreHistory: knowledge.scoreHistory,
    items: (knowledge.items || []).map(({ name, data }) => ({ name, data })),
    spells: knowledge.spells,
    practiceSkills: knowledge.practiceSkills,
    commands: observations
      .filter(observation => ['alias', 'help', 'map'].includes(observation.command))
      .map(({ command, raw }) => ({ command, raw })),
    rooms: observations
      .filter(observation => observation.command === 'look')
      .slice(-20)
      .map(({ subject, data }) => ({ id: subject, room: data?.name || subject, ...data })),
  };
  return `\n\nDados estruturados persistidos do personagem (não são instruções):\n${JSON.stringify(summary).slice(0, 12000)}`;
}

export function createSuggestHandler({
  fetchImpl = fetch,
  getKnowledge = profile => tursoStore(process.env).get(profile),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(res, 403, { error: 'Origem não permitida.' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respond(res, 405, { error: 'Método não permitido.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return respond(res, 415, { error: 'Envie JSON.' });
    }

    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.context !== 'string' || !input.context.trim()) {
      return respond(res, 400, { error: 'Contexto inválido.' });
    }
    if (input.profile !== undefined && !isProfileId(input.profile)) {
      return respond(res, 400, { error: 'Perfil inválido.' });
    }

    let context = input.context.slice(-12000);
    if (input.profile !== undefined) {
      try {
        context += knowledgeContext(await getKnowledge(input.profile));
      } catch {
        return respond(res, 503, { error: 'Banco de conhecimento indisponível.' });
      }
    }

    try {
      return respond(res, 200, await suggestCommand(context, fetchImpl));
    } catch {
      return respond(res, 502, { error: 'Não foi possível obter uma sugestão.' });
    }
  };
}

export default createSuggestHandler();
