import test from 'node:test';
import assert from 'node:assert/strict';
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
  class WebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.sent = []; webSocket = this; }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let request;
  const context = {
    document: { getElementById, createElement: () => new Element() },
    WebSocket,
    AbortController,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ explanation: 'Confira a sala.', command: 'look' }) };
    },
  };
  vm.runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);

  const get = getElementById;
  get('connect').onclick();
  webSocket.readyState = WebSocket.OPEN;
  webSocket.onopen();
  assert.equal(get('sharing').disabled, false);
  get('command').value = '';
  get('command-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(webSocket.sent, ['']);

  webSocket.onmessage({ data: 'mensagem anterior\n' });
  get('sharing').checked = true;
  get('sharing').onchange();
  webSocket.onmessage({ data: 'nova sala\n' });
  await get('suggest').onclick();
  assert.equal(request.url, 'https://mud-fataldimensions.mosaicoworkers.workers.dev/api/suggest');
  assert.equal(JSON.parse(request.options.body).context, 'nova sala\n');
  assert.equal(get('suggested-command').textContent, 'look');

  get('approve').onclick();
  assert.deepEqual(webSocket.sent, ['', 'look']);
});
