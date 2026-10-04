import { AgentTelnetSession } from '../lib/agent-telnet.js';
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

  const session = new AgentTelnetSession({
    username,
    password,
    profileId,
    apiOrigin: process.env.MUD_API_ORIGIN || 'https://mud-indol.vercel.app',
  });
  try {
    console.log(await session.connect());
    const { output, persistence } = await session.send('look');
    process.stdout.write(output);
    if (persistence && !persistence.saved) {
      const detail = persistence.code || persistence.errorType || `HTTP ${persistence.status}`;
      console.error(`Observation was not saved (${detail}).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MUD session failed.');
    process.exitCode = 1;
  } finally {
    await session.disconnect();
  }
}

main();
