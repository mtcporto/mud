import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseTargets, resolvePublicTarget } from './lib/network.js';
import { TelnetDecoder, encodeCommand } from './lib/telnet.js';
import { suggestCommand } from './lib/copilot.js';
import { createKnowledge, observe, publicKnowledge } from './lib/observations.js';
import googleCallback from './api/auth/google/callback.js';
import googleStart from './api/auth/google/start.js';
import googleLogout from './api/auth/logout.js';
import googleSession from './api/auth/session.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC = new Map([['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']], ['/app.js',['public/app.js','text/javascript']], ['/agent-controller.js',['public/agent-controller.js','text/javascript']], ['/auth-controller.js',['public/auth-controller.js','text/javascript']], ['/agent.css',['public/agent.css','text/css']], ['/styles.css',['public/styles.css','text/css']]]);
const COOKIE = 'mud_session';
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createMudServer({ targets = parseTargets(process.env.MUD_TARGETS), publicOrigin = process.env.PUBLIC_ORIGIN, resolveTarget = resolvePublicTarget, fetchImpl = fetch, connectTimeout = 10_000, maxSessions = 100 } = {}) {
  const sessions = new Map();
  const rates = new Map();
  const pending = new Map();

  function push(session, type, data = {}) {
    const event = { id: ++session.sequence, type, ...data };
    session.events.push(event);
    while (session.events.length > 150 || Buffer.byteLength(JSON.stringify(session.events)) > 128000) session.events.shift();
    if (session.stream && !session.stream.destroyed) {
      if (!session.stream.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) session.stream.destroy();
    }
  }
  function closeSession(session, reason = 'Conexão encerrada.') {
    session.connected = false;
    session.aiController?.abort();
    session.sharing = false;
    session.context = '';
    session.socket?.destroy();
    push(session, 'closed', { message: reason });
    session.stream?.end();
    sessions.delete(session.id);
  }
  function currentSession(req) {
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
    const id = cookie?.slice(COOKIE.length + 1);
    return id && sessions.get(id);
  }
  function rate(key, maximum, interval) {
    const now = Date.now();
    let record = rates.get(key);
    if (!record || record.until < now) { record = { count: 0, until: now + interval }; rates.set(key, record); }
    if (++record.count > maximum) throw fail(429, 'Muitas tentativas. Aguarde um pouco.');
  }
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'Envie JSON.');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw fail(413, 'Requisição muito grande.');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw fail(400, 'JSON inválido.'); }
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

  async function connect(req, res, input, origin) {
    const ip = req.socket.remoteAddress;
    rate(`connect:${ip}`, 6, 60_000);
    const target = targets.find(t => t.id === input.target);
    if (!target) throw fail(400, 'Escolha um servidor da lista.');
    const old = currentSession(req);
    if (old) closeSession(old);
    if (sessions.size + [...pending.values()].reduce((a,b) => a+b,0) >= maxSessions || [...sessions.values()].filter(s => s.ip === ip).length + (pending.get(ip) || 0) >= 3) throw fail(429, 'Limite de conexões atingido.');
    pending.set(ip, (pending.get(ip) || 0) + 1);
    const session = { id: randomBytes(32).toString('hex'), ip, target, events: [], sequence: 0, context: '', knowledge: createKnowledge(), observationBuffer: '', lastCommand: '', sharing: false, connected: false, sensitive: false, lastUserActivity: Date.now(), detachedAt: Date.now(), stream: null, socket: null, aiBusy: false, lastAi: 0 };
    let abandoned = false;
    res.once('close', () => { if (!res.writableEnded) { abandoned = true; if (sessions.has(session.id)) closeSession(session); else session.socket?.destroy(); } });
    try {
      let dnsTimer;
      const address = await Promise.race([resolveTarget(target.host), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), connectTimeout); dnsTimer.unref(); })]).finally(() => clearTimeout(dnsTimer));
      if (abandoned) throw new Error('Client left');
      const socket = new net.Socket(); session.socket = socket;
      socket.setKeepAlive(true, 30_000); socket.setNoDelay(true);
      const decoder = new TelnetDecoder(bytes => { if (!socket.destroyed) socket.write(bytes); }, enabled => {
        session.sensitive = enabled;
        if (enabled) { session.sharing = false; session.context = ''; session.aiController?.abort(); }
        push(session, 'privacy', { sensitive: enabled, sharing: session.sharing });
      }, target.encoding || 'utf-8');
      socket.on('data', bytes => {
        // Bound both output and work from an unexpectedly noisy upstream.
        try { rate(`output:${session.id}`, 300, 10_000); } catch { closeSession(session, 'Servidor enviou dados em excesso.'); return; }
        const text = decoder.feed(bytes);
        if (!text) return;
        session.prompt = ((session.prompt || '') + text).slice(-500);
        if (/(?:password|passphrase|senha)\s*[:?>]?\s*$/i.test(session.prompt)) {
          session.sensitive = true; session.sharing = false; session.context = ''; session.aiController?.abort();
          push(session, 'privacy', { sensitive: true, sharing: false });
        }
        push(session, 'output', { text, runs: decoder.runs });
        session.observationBuffer = (session.observationBuffer + text).slice(-12000);
        observe(session.knowledge, session.lastCommand, session.observationBuffer);
        if (session.sharing && !session.sensitive) session.context = (session.context + text).slice(-12000);
      });
      await new Promise((resolveConnect, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Connection timeout')); }, connectTimeout);
        socket.once('connect', () => { clearTimeout(timer); session.connected = true; resolveConnect(); });
        socket.on('error', () => { clearTimeout(timer); if (!session.connected) reject(new Error('Connection failed')); else closeSession(session, 'A conexão com o jogo falhou.'); });
        socket.once('close', () => { clearTimeout(timer); if (session.connected) closeSession(session, 'O servidor encerrou a conexão.'); else reject(new Error('Connection closed')); });
        socket.connect(target.port, address);
      });
      if (abandoned) throw new Error('Client left');
      sessions.set(session.id, session);
      res.setHeader('Set-Cookie', `${COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${origin.startsWith('https:') ? '; Secure' : ''}`);
      json(res, 201, { connected: true, target: target.id, sharing: false });
    } catch {
      session.socket?.destroy();
      throw fail(502, 'Não foi possível conectar ao servidor MUD.');
    } finally {
      const count = (pending.get(ip) || 1) - 1;
      if (count) pending.set(ip, count); else pending.delete(ip);
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const origin = publicOrigin || `http://${req.headers.host}`;
      if (!publicOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw fail(403, 'Configure PUBLIC_ORIGIN para acesso externo.');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        return res.end(await readFile(resolve(ROOT, file)));
      }
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { targets: targets.map(({ id, name, host, port }) => ({ id, name, host, port })) });
      const googleAuthRoutes = new Map([
        ['/api/auth/google/start', googleStart],
        ['/api/auth/google/callback', googleCallback],
        ['/api/auth/session', googleSession],
        ['/api/auth/logout', googleLogout],
      ]);
      const googleAuthHandler = googleAuthRoutes.get(url.pathname);
      if (googleAuthHandler) return await googleAuthHandler(req, res);
      if (!url.pathname.startsWith('/api/')) throw fail(404, 'Página não encontrada.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Origem não permitida.');
      if (req.method !== 'GET' && req.method !== 'POST') throw fail(405, 'Método não permitido.');
      if (req.method === 'POST' && req.headers.origin !== origin) throw fail(403, 'Origem não permitida.');
      if (url.pathname === '/api/connect' && req.method === 'POST') return await connect(req, res, await body(req), origin);
      const session = currentSession(req);
      if (!session) throw fail(401, 'Conecte-se ao MUD para continuar.');
      // Refresh a session cookie during active use; never expose its token to JS.
      res.setHeader('Set-Cookie', `${COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${origin.startsWith('https:') ? '; Secure' : ''}`);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { connected: session.connected, target: session.target.id, sharing: session.sharing, sensitive: session.sensitive });
      if (url.pathname === '/api/knowledge' && req.method === 'GET') return json(res, 200, publicKnowledge(session.knowledge));
      if (url.pathname === '/api/events' && req.method === 'GET') {
        session.stream?.end(); session.stream = res; session.detachedAt = null;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const last = Number(req.headers['last-event-id'] || 0);
        for (const event of session.events) if (!Number.isSafeInteger(last) || event.id > last) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        res.write('event: ready\ndata: {}\n\n');
        const ping = setInterval(() => res.write(': keepalive\n\n'), 15000);
        res.once('close', () => { clearInterval(ping); if (session.stream === res) { session.stream = null; session.detachedAt = Date.now(); } });
        return;
      }
      if (req.method !== 'POST') throw fail(404, 'Rota não encontrada.');
      const input = await body(req);
      session.lastUserActivity = Date.now();
      if (url.pathname === '/api/disconnect') {
        closeSession(session); res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/privacy') {
        if (typeof input.sharing !== 'boolean') throw fail(400, 'Configuração inválida.');
        session.aiController?.abort(); session.context = ''; session.sharing = input.sharing;
        if (input.sharing) session.sensitive = false;
        return json(res, 200, { sharing: session.sharing });
      }
      if (url.pathname === '/api/command') {
        rate(`command:${session.id}`, 30, 10000);
        if (!session.connected || session.socket.destroyed) throw fail(409, 'A conexão foi encerrada.');
        if (typeof input.command !== 'string' || input.command.length > 500 || /[\x00-\x1f\x7f]/.test(input.command) || session.socket.writableLength > 65536) throw fail(400, 'Envie um comando por vez, com até 500 caracteres.');
        if (input.sensitive === true || session.sensitive) { session.sharing = false; session.context = ''; session.aiController?.abort(); }
        let encoded;
        try { encoded = encodeCommand(input.command, session.target.encoding); } catch { throw fail(400, 'O servidor não aceita um dos caracteres enviados.'); }
        session.socket.write(encoded);
        session.lastCommand = input.command;
        session.observationBuffer = '';
        // Never retain commands: they may contain passwords even without masking.
        return json(res, 200, { ok: true, sharing: session.sharing });
      }
      if (url.pathname === '/api/suggest') {
        if (!session.sharing || session.sensitive || !session.context.trim()) throw fail(409, 'Ative a análise e receba texto do jogo antes de pedir uma sugestão.');
        if (session.aiBusy || Date.now() - session.lastAi < 10000) throw fail(429, 'Aguarde antes de pedir outra sugestão.');
        session.aiBusy = true; session.lastAi = Date.now(); session.aiController = new AbortController();
        const knowledge = JSON.stringify(publicKnowledge(session.knowledge));
        try { const suggestion = await suggestCommand(`${session.context}\n\nFatos estruturados já observados (podem estar incompletos):\n${knowledge}`, fetchImpl, session.aiController.signal); session.aiController.signal.throwIfAborted(); return json(res, 200, suggestion); }
        catch { throw fail(502, 'Não foi possível obter uma sugestão. Tente novamente.'); }
        finally { session.aiBusy = false; session.aiController = null; }
      }
      throw fail(404, 'Rota não encontrada.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'Erro interno ao processar a solicitação.' });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) if (now - session.lastUserActivity > 1800000 || session.detachedAt && now - session.detachedAt > 90000) closeSession(session, 'Sessão expirada por inatividade.');
    for (const [key, value] of rates) if (value.until < now) rates.delete(key);
  }, 15000);
  cleanup.unref();
  const shutdown = () => { clearInterval(cleanup); for (const session of sessions.values()) closeSession(session); server.closeAllConnections(); return new Promise(resolveClose => server.close(resolveClose)); };
  return { server, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.NODE_ENV === 'production' && !/^https:\/\//.test(process.env.PUBLIC_ORIGIN || '')) throw new Error('Set PUBLIC_ORIGIN to the public HTTPS URL');
  const app = createMudServer();
  app.server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`MUD ready on port ${app.server.address().port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.shutdown(); process.exit(0); });
}
