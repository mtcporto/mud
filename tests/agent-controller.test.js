import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const PROFILE_ID = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';

class Element {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.checked = false;
    this.scrollHeight = 0;
    this.attributes = {};
    this.classList = { toggle() {} };
    this.children = [];
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(child) { this.children.push(child); }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for the agent controller.');
}

test('web agent waits for an in-game prompt, sends autonomous commands, and stops at level 10', async () => {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const listeners = new Map();
  const sent = [];
  const requests = [];
  const socket = { readyState: 1 };
  const window = {
    mudAgentSocket: () => socket,
    mudAgentSendCommand(command) { sent.push(command); return true; },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) callback(event);
    },
  };
  const context = {
    document: { getElementById },
    window,
    WebSocket: { OPEN: 1 },
    localStorage: { getItem: key => key === 'mud-copilot-profile' ? PROFILE_ID : null },
    AbortController,
    setTimeout: (callback, ms, ...args) => setTimeout(callback, Math.max(1, ms / 100), ...args),
    clearTimeout,
    Date,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ command: 'score', explanation: 'Verify the current level.' }),
      };
    },
  };
  const source = await readFile(new URL('../public/agent-controller.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);

  window.dispatchEvent({ type: 'mud-agent-output', detail: 'Password: ' });
  assert.equal(getElementById('agent-toggle').disabled, true);
  window.dispatchEvent({
    type: 'mud-agent-output',
    detail: 'The Temple Of Fatal\r\n7073/7073hp 4051/4051ma 810mv | NSU > ',
  });
  assert.equal(getElementById('agent-control').hidden, true);
  window.dispatchEvent({ type: 'mud-google-auth', detail: { isAdmin: false } });
  assert.equal(getElementById('agent-toggle').disabled, true);
  window.dispatchEvent({ type: 'mud-google-auth', detail: { isAdmin: true } });
  assert.equal(getElementById('agent-control').hidden, false);
  assert.equal(getElementById('agent-toggle').disabled, false);

  getElementById('agent-toggle').onclick();
  assert.deepEqual(sent, ['look']);
  window.dispatchEvent({
    type: 'mud-agent-output',
    detail: 'The Temple Of Fatal\r\nA quiet sanctuary.\r\n7073/7073hp 4051/4051ma 810mv | NSU > ',
  });
  await until(() => sent.includes('score'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/agent-decision');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].body.profile, PROFILE_ID);
  assert.match(requests[0].body.context, /A quiet sanctuary/);
  assert.doesNotMatch(requests[0].body.context, /Password:/);

  window.dispatchEvent({
    type: 'mud-agent-output',
    detail: 'Name: Luna  Level: 10\r\n7073/7073hp 4051/4051ma 810mv | NSU > ',
  });
  await until(() => /Nível 10 confirmado/.test(getElementById('agent-status').textContent));
  assert.deepEqual(sent, ['look', 'score']);
  assert.equal(getElementById('agent-toggle').attributes['aria-pressed'], 'false');
});
