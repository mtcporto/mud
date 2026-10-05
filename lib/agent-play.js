import { isProfileId } from './profile.js';

const MAX_TURNS = 3;
const SAFE_COMMAND = /^(?:look|score|spells|alias|equip(?:ment)?|help|map|practice|affects?|effects?|[nsewud]|north|south|east|west|up|down)$/i;

export function isSafeAgentCommand(command) {
  const value = typeof command === 'string' ? command.trim() : '';
  return SAFE_COMMAND.test(value) || /^examine\s+\S.{0,100}$/i.test(value);
}

function pauseReason(output) {
  if (/alas,\s*you cannot go that way|(?:attacks?|hits?|bites?|claws?|slashes?|stabs?)\s+you\b|\b(?:poisoned|blinded|paralyzed|dead)\b|\b(?:has arrived|has followed you)\b/i.test(output)) {
    return 'unexpected game event';
  }
  const hp = output.match(/\b(\d+)\/(\d+)hp\b/i);
  if (hp && Number(hp[2]) > 0 && Number(hp[1]) / Number(hp[2]) < 0.5) return 'HP below 50%';
  return null;
}

async function requestSuggestion(apiOrigin, profileId, context, fetchImpl) {
  const response = await fetchImpl(new URL('/api/suggest', apiOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, profile: profileId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AI suggestion failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (typeof result.command !== 'string' || typeof result.explanation !== 'string') {
    throw new Error('AI returned an invalid suggestion.');
  }
  return { command: result.command, explanation: result.explanation };
}

export async function playLunaWithAi({
  session,
  profileId,
  apiOrigin = 'https://mud-indol.vercel.app',
  fetchImpl = fetch,
  maxTurns = MAX_TURNS,
  onOutput = () => {},
  onSuggestion = () => {},
} = {}) {
  if (!session || typeof session.send !== 'function') throw new Error('A connected MUD session is required.');
  if (!isProfileId(profileId)) throw new Error('MUD_PROFILE_ID must be a valid UUID.');
  if (!Number.isInteger(maxTurns) || maxTurns < 0 || maxTurns > MAX_TURNS) {
    throw new Error(`AI play is limited to ${MAX_TURNS} turns per run.`);
  }
  const origin = new URL(apiOrigin).origin;
  const actions = [];
  const first = await session.send('look');
  actions.push('look');
  onOutput({ command: 'look', ...first });
  let context = first.output;
  let reason = pauseReason(context);

  for (let turn = 0; turn < maxTurns && !reason; turn += 1) {
    const suggestion = await requestSuggestion(origin, profileId, context.slice(-12000), fetchImpl);
    if (!isSafeAgentCommand(suggestion.command)) {
      reason = 'suggested action outside the safe test allowlist';
      break;
    }
    onSuggestion(suggestion);
    const result = await session.send(suggestion.command.trim());
    actions.push(suggestion.command.trim());
    onOutput({ command: suggestion.command.trim(), ...result });
    context = `${context}\n> ${suggestion.command.trim()}\n${result.output}`.slice(-12000);
    reason = pauseReason(result.output);
  }
  return { actions, reason: reason || 'turn limit reached' };
}
