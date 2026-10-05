import { AgentTelnetSession } from '../lib/agent-telnet.js';
import { playLunaWithAi } from '../lib/agent-play.js';
import { isProfileId } from '../lib/profile.js';

async function main() {
  const username = process.env.MUD_USERNAME;
  const password = process.env.MUD_PASSWORD;
  const profileId = process.env.MUD_PROFILE_ID;
  if (!username || !password) {
    console.error('MUD credentials are not configured.');
    process.exitCode = 1;
    return;
  }
  if (!isProfileId(profileId)) {
    console.error('MUD_PROFILE_ID must be a valid UUID.');
    process.exitCode = 1;
    return;
  }

  const apiOrigin = process.env.MUD_API_ORIGIN || 'https://mud-indol.vercel.app';
  const session = new AgentTelnetSession({ username, password, profileId, apiOrigin });
  try {
    console.log(await session.connect());
    const result = await playLunaWithAi({
      session,
      profileId,
      apiOrigin,
      onOutput({ command, output, persistence }) {
        process.stdout.write(`\n> ${command}\n${output}`);
        if (persistence && !persistence.saved) {
          const detail = persistence.code || persistence.errorType || `HTTP ${persistence.status}`;
          console.error(`Observation was not saved (${detail}).`);
        }
      },
      onSuggestion({ command, explanation }) {
        console.log(`\nAI: ${explanation}\nExecuting approved safe test action: ${command}`);
      },
    });
    console.log(`AI Telnet test stopped after ${result.actions.length - 1} AI action(s): ${result.reason}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'AI Telnet test failed.');
    process.exitCode = 1;
  } finally {
    await session.disconnect();
  }
}

main();
