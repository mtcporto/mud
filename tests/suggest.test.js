import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuggestHandler } from '../api/suggest.js';

function responseMock() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Vercel suggestion API validates inputs and routes through the configured model', async t => {
  const previousBase = process.env.AI_BASE_URL;
  const previousModel = process.env.AI_MODEL;
  process.env.AI_BASE_URL = 'https://ai.example/v1';
  process.env.AI_MODEL = 'mud-test-model';
  t.after(() => {
    if (previousBase === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = previousBase;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  });

  let receivedPayload;
  let requestedProfile;
  const handler = createSuggestHandler({
    getKnowledge: async profile => {
      requestedProfile = profile;
      return {
        profile: { characterName: 'Luna' },
        characterCreation: { skillChoices: [{ name: 'sword', state: 'selected' }] },
        items: [{ name: 'sword', data: { damage: '1d6' } }],
        observations: [
          { command: 'look', subject: 'square', data: { name: 'Town Square' } },
          { command: 'say', subject: '', raw: 'private text' },
        ],
      };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://ai.example/v1/chat/completions');
      assert.equal(options.headers.Authorization, undefined);
      receivedPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: 'mud-test-model',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ explanation: 'A saída sul está confirmada.', command: 'south' }) },
        }],
      }), { status: 200 });
    },
  });
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: { origin: 'https://mud-indol.vercel.app', 'content-type': 'application/json' },
    body: {
      context: 'A sala atual tem uma saída ao sul.',
      profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { explanation: 'A saída sul está confirmada.', command: 'south' });
  assert.equal(requestedProfile, '410b4c85-7ff2-4bd2-94bb-3e241e791c05');
  assert.match(receivedPayload.messages[1].content, /A sala atual tem uma saída ao sul/);
  assert.match(receivedPayload.messages[1].content, /Town Square/);
  assert.doesNotMatch(receivedPayload.messages[1].content, /private text/);

  const blocked = responseMock();
  await handler({
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: { context: 'room' },
  }, blocked);
  assert.equal(blocked.statusCode, 403);

  const invalid = responseMock();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { context: 'room', profile: 'invalid' },
  }, invalid);
  assert.equal(invalid.statusCode, 400);
});
