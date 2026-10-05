import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeAgentCommand, playLunaWithAi } from '../lib/agent-play.js';

const PROFILE_ID = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';

test('Telnet AI play executes only bounded safe commands and pauses on unsafe suggestions', async () => {
  const commands = [];
  const requests = [];
  const session = {
    async send(command) {
      commands.push(command);
      return {
        output: command === 'look'
          ? 'Test Square\r\n[Exits: south]\r\n100/100hp 80/80ma 50mv | S > '
          : 'Quiet Lane\r\n[Exits: north]\r\n98/100hp 80/80ma 48mv | N > ',
        persistence: command === 'look' ? { saved: true } : null,
      };
    },
  };
  const result = await playLunaWithAi({
    session,
    profileId: PROFILE_ID,
    maxTurns: 3,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      const command = requests.length === 1 ? 'south' : 'kill guard';
      return new Response(JSON.stringify({
        command,
        explanation: 'One safe next action.',
      }), { status: 200 });
    },
  });

  assert.deepEqual(commands, ['look', 'south']);
  assert.deepEqual(result.actions, ['look', 'south']);
  assert.equal(result.reason, 'suggested action outside the safe test allowlist');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://mud-indol.vercel.app/api/suggest');
  assert.equal(requests[0].body.profile, PROFILE_ID);
  assert.match(requests[1].body.context, /Quiet Lane/);
});

test('Telnet AI play stops on combat or low HP before requesting another action', async () => {
  let suggestions = 0;
  const result = await playLunaWithAi({
    session: {
      async send() {
        return { output: 'A guard attacks you!\r\n40/100hp 80/80ma 50mv | N > ', persistence: null };
      },
    },
    profileId: PROFILE_ID,
    fetchImpl: async () => {
      suggestions += 1;
      throw new Error('must not call AI after a hazard');
    },
  });
  assert.deepEqual(result.actions, ['look']);
  assert.equal(result.reason, 'unexpected game event');
  assert.equal(suggestions, 0);
});

test('Telnet AI allowlist permits information, examination and movement only', () => {
  for (const command of ['look', 'score', 'examine sword', 'south', 'u']) {
    assert.equal(isSafeAgentCommand(command), true, command);
  }
  for (const command of ['kill guard', 'cast fireball', 'drop all', 'south;quit', 'password secret']) {
    assert.equal(isSafeAgentCommand(command), false, command);
  }
});
