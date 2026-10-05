import { connect } from 'cloudflare:sockets';
import { TelnetDecoder } from '../lib/telnet.js';
import { commandCategory } from '../lib/observations.js';
import { isProfileId } from '../lib/profile.js';

const HOST = 'mud.fataldimensions.nl';
const PORT = 4000;
const ALLOWED_ORIGINS = new Set(['https://mud-indol.vercel.app', 'http://127.0.0.1:3001', 'http://localhost:3001']);

export class MudSession {
  constructor(ctx) {
    this.ctx = ctx; this.socket = null; this.client = null;
    this.profileId = null; this.apiOrigin = null; this.pendingObservation = null; this.observationTimer = null;
    this.creationBuffer = ''; this.creationTimer = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    this.profileId = new URL(request.url).searchParams.get('profile');
    this.apiOrigin = request.headers.get('Origin');
    if (this.profileId && !isProfileId(this.profileId)) return new Response('Perfil inválido', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.client = server; server.accept();
    server.addEventListener('message', event => {
      this.sendCommand(String(event.data)).catch(() => this.reportCommandFailure());
    });
    server.addEventListener('close', () => {
      this.flushObservation();
      this.flushCreation();
      this.client = null; this.socket?.close(); this.socket = null;
    });
    this.ctx.waitUntil(this.open());
    return new Response(null, { status: 101, webSocket: client });
  }

  async open() {
    try {
      this.socket = connect({ hostname: HOST, port: PORT });
      const writer = this.socket.writable.getWriter(); this.writer = writer;
      this.observationDecoder = new TelnetDecoder(bytes => this.writer?.write(bytes), () => {}, 'windows-1252');
      const reader = this.socket.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.client?.readyState === WebSocket.OPEN) this.client.send(value);
        this.captureOutput(this.observationDecoder.feed(value));
      }
    } catch (error) {
      if (this.client?.readyState === WebSocket.OPEN) this.client.close(1011, 'Conexão com o MUD falhou');
    } finally {
      this.flushObservation();
      this.flushCreation();
      this.writer?.releaseLock(); this.socket = null;
    }
  }

  captureOutput(text) {
    if (text) {
      this.creationBuffer = (this.creationBuffer + text).slice(-12000);
      if (/\bCharacter\s*:[\s\S]*?\bCreation Points\s*:/i.test(this.creationBuffer)) {
        clearTimeout(this.creationTimer);
        this.creationTimer = setTimeout(() => this.flushCreation(), 1200);
      }
    }
    if (!text || !this.pendingObservation) return;
    this.pendingObservation.text = (this.pendingObservation.text + text).slice(-12000);
    this.pendingObservation.promptTail = (this.pendingObservation.promptTail + text).slice(-300);
    const continuation = /(?:--more--|hit return to continue|please type[^:\r\n]*return)/i.test(this.pendingObservation.promptTail);
    this.pendingObservation.waitingForContinue = continuation;
    clearTimeout(this.observationTimer);
    this.observationTimer = null;
    if (!continuation) {
      this.observationTimer = setTimeout(() => {
        this.observationTimer = null;
        this.flushObservation();
      }, 1200);
    }
  }

  flushObservation() {
    clearTimeout(this.observationTimer);
    this.observationTimer = null;
    const observation = this.pendingObservation;
    this.pendingObservation = null;
    if (observation?.text.trim()) this.ctx.waitUntil(this.saveObservation(observation));
  }

  flushCreation() {
    clearTimeout(this.creationTimer);
    this.creationTimer = null;
    const text = this.creationBuffer;
    this.creationBuffer = '';
    const start = text.search(/\bCharacter\s*:/i);
    if (start >= 0) this.ctx.waitUntil(this.saveObservation({ command: 'creation', text: text.slice(start) }));
  }

  async saveObservation(observation) {
    if (!this.profileId) return;
    const category = commandCategory(observation.command)?.command || 'unknown';
    let response;
    try {
      response = await fetch(new URL('/api/knowledge', this.apiOrigin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: this.profileId, command: observation.command, text: observation.text }),
      });
    } catch (error) {
      this.reportSaveFailure(category, null, error instanceof Error ? error.name : 'UnknownError');
      return;
    }
    if (response.ok) return;

    const body = await response.json().catch(() => null);
    const reason = typeof body?.error === 'string' ? body.error.slice(0, 160) : 'No API error detail';
    const code = typeof body?.code === 'string' ? body.code.slice(0, 64) : null;
    if (response.status >= 400 && response.status < 500) {
      this.reportObservationRejected(category, response.status, code, reason);
      return;
    }
    this.reportSaveFailure(category, response.status, code || reason);
  }

  reportObservationRejected(category, status, code, reason) {
    console.warn('MUD observation rejected by knowledge API.', { category, status, code, reason });
    if (this.client?.readyState === WebSocket.OPEN) {
      const detail = code ? `, ${code}` : '';
      this.client.send(new TextEncoder().encode(`\r\n[ Aviso: observacao ${category} rejeitada (HTTP ${status}${detail}). ]\r\n`));
    }
  }

  reportSaveFailure(category, status, reason) {
    console.error('MUD observation persistence failed.', { category, status, reason });
    if (this.client?.readyState === WebSocket.OPEN) {
      const cause = status === null ? 'falha de rede' : `HTTP ${status}`;
      this.client.send(new TextEncoder().encode(`\r\n[Erro: falha ao salvar observacao ${category} (${cause}).]\r\n`));
    }
  }

  reportCommandFailure() {
    console.error('Could not forward a MUD command.');
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(new TextEncoder().encode('\r\n[Erro: comando nao enviado ao jogo.]\r\n'));
    }
  }

  async sendCommand(command) {
    if (!this.writer || typeof command !== 'string' || command.length > 500 || /[\x00-\x1f\x7f]/.test(command)) return;
    const pending = this.pendingObservation;
    if (pending) {
      const continuation = pending.waitingForContinue && (!command.trim() || /^(?:c|continue)$/i.test(command.trim()));
      if (continuation) {
        pending.waitingForContinue = false;
        pending.promptTail = '';
        clearTimeout(this.observationTimer);
        this.observationTimer = null;
      } else this.flushObservation();
    }
    if (commandCategory(command)) {
      this.pendingObservation = { command: command.trim(), text: '', promptTail: '', waitingForContinue: false };
    }
    await this.writer.write(new TextEncoder().encode(`${command}\r\n`));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config') return Response.json({ targets: [{ id: 'fatal', name: 'Fatal Dimensions', host: HOST, port: PORT }] });
    if (url.pathname === '/api/ws') {
      const origin = request.headers.get('Origin');
      if (!ALLOWED_ORIGINS.has(origin)) return new Response('Origem não permitida', { status: 403 });
      const profileId = url.searchParams.get('profile');
      if (profileId && !isProfileId(profileId)) return new Response('Perfil inválido', { status: 400 });
      const id = env.MUD_SESSION.idFromName(crypto.randomUUID());
      return env.MUD_SESSION.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
