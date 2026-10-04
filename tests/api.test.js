import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/knowledge.js';

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

  const unsupportedMethod = responseMock();
  await handler({ method: 'OPTIONS', headers: {}, query: {} }, unsupportedMethod);
  assert.equal(unsupportedMethod.statusCode, 405);
  assert.equal(unsupportedMethod.headers.Allow, 'GET, POST, DELETE');
});
