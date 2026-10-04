import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/knowledge.js';
import { TursoKnowledgeStore } from '../lib/turso.js';

function responseMock() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Vercel knowledge API restricts browser origins and rejects invalid requests before database access', async () => {
  const blocked = responseMock();
  await handler({ method: 'GET', headers: { origin: 'https://evil.example' }, query: { profile: 'invalid' } }, blocked);
  assert.equal(blocked.statusCode, 403);

  const invalidProfile = responseMock();
  await handler({ method: 'GET', headers: {}, query: { profile: 'invalid' } }, invalidProfile);
  assert.equal(invalidProfile.statusCode, 400);

  const unknownCommand = responseMock();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05', command: 'say hi', text: 'private message' },
  }, unknownCommand);
  assert.equal(unknownCommand.statusCode, 400);
  assert.equal(unknownCommand.body.code, 'UNKNOWN_COMMAND');

  const unparseableObservation = responseMock();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05',
      command: 'examine missing item',
      text: 'You do not see that here.',
    },
  }, unparseableObservation);
  assert.equal(unparseableObservation.statusCode, 422);
  assert.equal(unparseableObservation.body.code, 'OBSERVATION_NOT_PARSED');

  const unsupportedMethod = responseMock();
  await handler({ method: 'OPTIONS', headers: {}, query: {} }, unsupportedMethod);
  assert.equal(unsupportedMethod.statusCode, 405);
  assert.equal(unsupportedMethod.headers.Allow, 'GET, POST, DELETE');
});

test('Vercel knowledge API saves the validated POST text', async t => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const originalSave = TursoKnowledgeStore.prototype.save;
  let saved;

  process.env.TURSO_DATABASE_URL = 'libsql://test.example';
  process.env.TURSO_AUTH_TOKEN = 'test-token';
  TursoKnowledgeStore.prototype.save = async function (profile, command, text) {
    saved = { profile, command, text };
  };
  t.after(() => {
    TursoKnowledgeStore.prototype.save = originalSave;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previousToken;
  });

  const text = 'Name : Luna       Level   : 1';
  const response = responseMock();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05', command: 'score', text },
  }, response);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(saved, {
    profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05',
    command: 'score',
    text,
  });

  const examineText = 'You see a sword of great but cheap craftsmanship.';
  const examineResponse = responseMock();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05',
      command: 'examine sword',
      text: examineText,
    },
  }, examineResponse);
  assert.equal(examineResponse.statusCode, 201);
  assert.deepEqual(saved, {
    profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c05',
    command: 'examine sword',
    text: examineText,
  });
});
