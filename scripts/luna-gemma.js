import { playLunaAutonomously } from '../lib/agent-autonomy.js';
import { AgentTelnetSession } from '../lib/agent-telnet.js';
import { isProfileId } from '../lib/profile.js';

async function main() {
  const username = process.env.MUD_USERNAME;
  const password = process.env.MUD_PASSWORD;
  const profileId = process.env.MUD_PROFILE_ID;
  const apiOrigin = process.env.MUD_API_ORIGIN || 'https://mud-indol.vercel.app';
  const model = (process.env.OLLAMA_MODEL || process.env.ollama_model || 'gemma4:31b').trim();
  const baseUrl = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1';
  const apiKey = process.env.OLLAMA_API_KEY;
  const maxTurns = Number(process.env.MUD_AGENT_MAX_TURNS || 1000);

  if (!username || !password || !isProfileId(profileId)) {
    throw new Error('MUD credentials or profile configuration is incomplete.');
  }
  if (!apiKey && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl)) {
    throw new Error('OLLAMA_API_KEY is required for the configured Ollama endpoint.');
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10000) {
    throw new Error('MUD_AGENT_MAX_TURNS must be an integer from 1 to 10000.');
  }

  const session = new AgentTelnetSession({ username, password, profileId, apiOrigin });
  try {
    console.log(`Requested Ollama model: ${model}`);
    console.log(await session.connect());
    const result = await playLunaAutonomously({
      session,
      profileId,
      apiOrigin,
      maxTurns,
      model,
      apiKey,
      baseUrl,
      onOutput({ command, output, persistence }) {
        process.stdout.write(`\n> ${command}\n${output}`);
        if (persistence && !persistence.saved) {
          const detail = persistence.code || persistence.errorType || `HTTP ${persistence.status}`;
          console.error(`Observation was not saved (${detail}).`);
        }
      },
      onSuggestion({ command, explanation }) {
        console.log(`\nGemma: ${explanation}\nExecuting: ${command}`);
      },
    });
    console.log(`Agent stopped after ${result.actions.length - 1} decision(s): ${result.reason}.`);
  } finally {
    await session.disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Gemma MUD agent failed.');
  process.exitCode = 1;
});
