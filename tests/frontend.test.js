import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('connected client sends blank Enter and only shares opted-in game output with GPT-4o', async () => {
  class Element {
    constructor() {
      this.textContent = '';
      this.children = [];
      this.disabled = false;
      this.checked = false;
      this.classList = { add() {} };
    }
    focus() {}
    replaceChildren() { this.children = []; this.textContent = ''; }
    append(child) { this.children.push(child); this.textContent += child.textContent; }
  }

  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let webSocket;
  const profileId = randomUUID();
  const localValues = new Map();
  const requests = [];
  const windowEvents = [];
  class Event {
    constructor(type) { this.type = type; }
  }
  class CustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options.detail; }
  }
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; webSocket = this; }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let request;
  const context = {
    document: { getElementById, createElement: () => new Element() },
    WebSocket,
    crypto: { randomUUID: () => profileId },
    localStorage: {
      getItem: key => localValues.get(key) || null,
      setItem: (key, value) => localValues.set(key, value),
    },
    confirm: () => true,
    window: { dispatchEvent: event => windowEvents.push(event) },
    Event,
    CustomEvent,
    AbortController,
    fetch: async (url, options) => {
      request = { url, options };
      requests.push(request);
      if (url.includes('/knowledge')) return {
        ok: true,
        json: async () => ({ profile: { characterName: 'Elvinn' }, equipmentAnalysis: { unexamined: [] } }),
      };
      return { ok: true, json: async () => ({ explanation: 'Confira a sala.', command: 'look' }) };
    },
  };
  vm.runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);

  const get = getElementById;
  get('connect').onclick();
  assert.equal(webSocket.url, `wss://mud-fataldimensions.mosaicoworkers.workers.dev/api/ws?profile=${profileId}`);
  webSocket.readyState = WebSocket.OPEN;
  webSocket.onopen();
  assert.equal(windowEvents[0].type, 'mud-agent-connected');
  assert.equal(get('sharing').disabled, false);
  get('command').value = '';
  get('command-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(webSocket.sent, ['']);
  assert.equal(get('terminal').textContent, '> [Enter]\n');

  get('command').value = 'score';
  get('command-form').onsubmit({ preventDefault() {} });
  get('sensitive').checked = true;
  get('sensitive').onchange();
  get('command').value = 'senha-secreta';
  get('command-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(webSocket.sent, ['', 'score', 'senha-secreta']);
  assert.match(get('terminal').textContent, /> score\n/);
  assert.match(get('terminal').textContent, /Entrada privada enviada; conteudo oculto/);
  assert.equal(get('terminal').textContent.includes('senha-secreta'), false);
  get('sensitive').checked = false;
  get('sensitive').onchange();

  webSocket.onmessage({ data: 'mensagem anterior\n' });
  get('sharing').checked = true;
  get('sharing').onchange();
  webSocket.onmessage({ data: 'nova sala\n' });
  assert.ok(windowEvents.some(event => event.type === 'mud-agent-output' && event.detail === 'nova sala\n'));
  await get('suggest').onclick();
  assert.equal(request.url, '/api/suggest');
  assert.equal(JSON.parse(request.options.body).profile, profileId);
  assert.equal(JSON.parse(request.options.body).context, 'nova sala\n');
  assert.equal(get('suggested-command').textContent, 'look');

  get('approve').onclick();
  assert.deepEqual(webSocket.sent, ['', 'score', 'senha-secreta', 'look']);
  assert.match(get('terminal').textContent, /> look\n/);

  await get('load-knowledge').onclick();
  assert.match(get('saved-knowledge').textContent, /Elvinn/);
  await get('clear-knowledge').onclick();
  assert.equal(requests.at(-1).options.method, 'DELETE');
  assert.match(get('saved-knowledge').textContent, /Dados apagados/);
});
