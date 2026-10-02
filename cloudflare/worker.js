import { connect } from 'cloudflare:sockets';

const HOST = 'mud.fataldimensions.nl';
const PORT = 4000;

export class MudSession {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.socket = null; this.client = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.client = server; server.accept();
    server.addEventListener('message', event => this.sendCommand(String(event.data)));
    server.addEventListener('close', () => { this.client = null; this.socket?.close(); this.socket = null; });
    this.ctx.waitUntil(this.open());
    return new Response(null, { status: 101, webSocket: client });
  }

  async open() {
    try {
      this.socket = connect({ hostname: HOST, port: PORT });
      const writer = this.socket.writable.getWriter(); this.writer = writer;
      const reader = this.socket.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.client?.readyState === WebSocket.OPEN) this.client.send(value);
      }
    } catch (error) {
      if (this.client?.readyState === WebSocket.OPEN) this.client.close(1011, 'Conexão com o MUD falhou');
    } finally { this.writer?.releaseLock(); this.socket = null; }
  }

  async sendCommand(command) {
    if (!this.writer || typeof command !== 'string' || command.length > 500 || /[\x00-\x1f\x7f]/.test(command)) return;
    await this.writer.write(new TextEncoder().encode(`${command}\r\n`));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config') return Response.json({ targets: [{ id: 'fatal', name: 'Fatal Dimensions', host: HOST, port: PORT }] });
    if (url.pathname === '/api/ws') {
      if (request.headers.get('Origin') !== url.origin) return new Response('Origem não permitida', { status: 403 });
      const id = env.MUD_SESSION.idFromName(crypto.randomUUID());
      return env.MUD_SESSION.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
