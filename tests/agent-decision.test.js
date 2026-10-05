import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDecisionHandler } from '../api/agent-decision.js';
import { createGoogleSessionCookie, GOOGLE_SESSION_COOKIE } from '../lib/google-auth.js';

const PROFILE_ID = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';
const AUTH_SECRET = 'test-google-client-secret';
const ADMIN_COOKIE = `${GOOGLE_SESSION_COOKIE}=${encodeURIComponent(
  createGoogleSessionCookie('mtcporto@gmail.com', 'google-subject', AUTH_SECRET),
)}`;

function responseMock() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('agent decision uses the server-side Ollama key with persistent knowledge', async () => {
  let request;
  const handler = createAgentDecisionHandler({
    env: {
      OLLAMA_API_KEY: 'server-only-ollama-key',
      OLLAMA_MODEL: 'gemma4:31b',
      GOOGLE_CLIENT_SECRET: AUTH_SECRET,
    },
    getKnowledge: async profile => {
      assert.equal(profile, PROFILE_ID);
      return {
        profile: { characterName: 'Luna' },
        observations: [{ command: 'look', subject: 'square', data: { name: 'Square' } }],
      };
    },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, payload: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        model: 'gemma4:31b',
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"command":"quest","explanation":"Check the available quest."}' },
        }],
      }), { status: 200 });
    },
  });
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: {
      origin: 'https://mud-indol.vercel.app',
      'content-type': 'application/json',
      cookie: ADMIN_COOKIE,
      'x-forwarded-for': '192.0.2.1',
    },
    body: { profile: PROFILE_ID, context: 'Current output from the game.' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { command: 'quest', explanation: 'Check the available quest.' });
  assert.equal(request.url, 'https://ollama.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer server-only-ollama-key');
  assert.match(request.payload.messages[1].content, /Current output from the game/);
  assert.match(request.payload.messages[1].content, /Square/);
  assert.doesNotMatch(JSON.stringify(res.body), /server-only-ollama-key/);
});

test('agent decision requires the Google admin session before loading memory or calling Ollama', async () => {
  let accesses = 0;
  const handler = createAgentDecisionHandler({
    env: { OLLAMA_API_KEY: 'server-only-ollama-key', GOOGLE_CLIENT_SECRET: AUTH_SECRET },
    getKnowledge: async () => { accesses += 1; return {}; },
    fetchImpl: async () => { throw new Error('Ollama must not be called'); },
  });
  const request = {
    method: 'POST',
    headers: {
      origin: 'https://mud-indol.vercel.app',
      'content-type': 'application/json',
    },
    body: { profile: PROFILE_ID, context: 'Current output.' },
  };
  const anonymous = responseMock();
  await handler(request, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(accesses, 0);

  const nonAdminCookie = `${GOOGLE_SESSION_COOKIE}=${encodeURIComponent(
    createGoogleSessionCookie('visitor@example.com', 'visitor-subject', AUTH_SECRET),
  )}`;
  const nonAdmin = responseMock();
  await handler({ ...request, headers: { ...request.headers, cookie: nonAdminCookie } }, nonAdmin);
  assert.equal(nonAdmin.statusCode, 403);
  assert.equal(accesses, 0);
});

test('agent decision rejects requests from unapproved origins before loading memory or calling Ollama', async () => {
  let accesses = 0;
  const handler = createAgentDecisionHandler({
    env: { OLLAMA_API_KEY: 'server-only-ollama-key', GOOGLE_CLIENT_SECRET: AUTH_SECRET },
    getKnowledge: async () => { accesses += 1; return {}; },
    fetchImpl: async () => { throw new Error('Ollama must not be called'); },
  });
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: {
      origin: 'https://unapproved.example',
      'content-type': 'application/json',
    },
    body: { profile: PROFILE_ID, context: 'Current output.' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(accesses, 0);
});

test('agent decision rejects model output that could disconnect or compound game commands', async () => {
  const handler = createAgentDecisionHandler({
    env: { OLLAMA_API_KEY: 'server-only-ollama-key', GOOGLE_CLIENT_SECRET: AUTH_SECRET },
    getKnowledge: async () => ({}),
    fetchImpl: async () => new Response(JSON.stringify({
      model: 'gemma4:31b',
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"command":"quit","explanation":"Exit."}' },
      }],
    }), { status: 200 }),
  });
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: {
      origin: 'https://mud-indol.vercel.app',
      'content-type': 'application/json',
      cookie: ADMIN_COOKIE,
      'x-forwarded-for': '192.0.2.2',
    },
    body: { profile: '410b4c85-7ff2-4bd2-94bb-3e241e791c06', context: 'Current output.' },
  }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /não pode ser executado/);
});
