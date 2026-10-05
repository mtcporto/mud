import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeAutonomousCommand, playLunaAutonomously, requestGemmaDecision } from '../lib/agent-autonomy.js';

const PROFILE_ID = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';

test('autonomous agent loads persistent knowledge before each model decision and executes open-ended gameplay commands', async () => {
  const commands = [];
  const decisions = [];
  let loaded = 0;
  const session = {
    async send(command) {
      commands.push(command);
      return { output: command === 'look'
        ? 'The Test Room\r\nA quiet room.\r\n[Exits: south]\r\n100/100hp 80/80ma 50mv | S > '
        : 'The trainer explains your available skills.\r\n100/100hp 80/80ma 50mv | S > ' };
    },
  };
  const result = await playLunaAutonomously({
    session,
    profileId: PROFILE_ID,
    maxTurns: 1,
    getKnowledge: async (origin, profile) => {
      loaded += 1;
      assert.equal(origin, 'https://mud-indol.vercel.app');
      assert.equal(profile, PROFILE_ID);
      return { profile: { characterName: 'Luna' }, observations: [] };
    },
    decide: async options => {
      decisions.push(options.context);
      return { command: 'skills', explanation: 'Discover available skills.' };
    },
  });

  assert.deepEqual(commands, ['look', 'skills']);
  assert.equal(loaded, 1);
  assert.match(decisions[0], /The Test Room/);
  assert.match(decisions[0], /Luna/);
  assert.deepEqual(result.actions, ['look', 'skills']);
  assert.equal(result.reason, 'turn limit reached');
});

test('autonomous agent stops after level 10 is confirmed by the game', async () => {
  let decisions = 0;
  const result = await playLunaAutonomously({
    session: {
      async send(command) {
        return { output: command === 'look'
          ? 'The Test Room\r\nDescription.\r\n[Exits: south]\r\n100/100hp 80/80ma 50mv | S > '
          : 'Name: Luna  Level: 10\r\n100/100hp 80/80ma 50mv | S > ' };
      },
    },
    profileId: PROFILE_ID,
    maxTurns: 4,
    getKnowledge: async () => ({}),
    decide: async () => {
      decisions += 1;
      return { command: 'score', explanation: 'Check progress.' };
    },
  });
  assert.equal(decisions, 1);
  assert.equal(result.reason, 'level 10 confirmed');
});

test('autonomous command validation allows ordinary MUD actions but blocks compound and account/destructive commands', () => {
  for (const command of [
    'skills', 'quest', 'practice sword', 'consider goblin', 'cast magic missile goblin',
    'say hello', 'tell Elvinn hello', 'gossip hello', 'set wimpy 20', 'flee', 'north',
  ]) {
    assert.equal(isSafeAutonomousCommand(command), true, command);
  }
  for (const command of [
    '', 'north;quit', 'north\nquit', 'password hunter2', 'login Luna', 'quit',
    'logout', 'delete character', 'suicide', '!look', '/help', ' '.repeat(201),
  ]) {
    assert.equal(isSafeAutonomousCommand(command), false, command);
  }
});

test('Gemma request uses requested Ollama model and parses one JSON action', async () => {
  let request;
  const suggestion = await requestGemmaDecision({
    context: 'Current MUD output.',
    apiKey: 'fixture-key',
    baseUrl: 'https://ollama.com/v1',
    model: 'gemma4:31b',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        model: 'gemma4:31b',
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"command":"quest","explanation":"Inspect quest progress."}' },
        }],
      }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://ollama.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(request.options.body).model, 'gemma4:31b');
  assert.deepEqual(suggestion, { command: 'quest', explanation: 'Inspect quest progress.' });
});
