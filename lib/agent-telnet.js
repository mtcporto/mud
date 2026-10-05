import net from 'node:net';
import { commandCategory, parseObservation } from './observations.js';
import { isProfileId } from './profile.js';
import { TelnetDecoder, encodeCommand } from './telnet.js';

const DEFAULT_HOST = 'mud.fataldimensions.nl';
const DEFAULT_PORT = 4000;
const MAX_RESPONSE_LENGTH = 12000;
const NAME_PROMPT = /by what name do you wish to be known\?\s*$/i;
const PASSWORD_PROMPT = /password\s*:\s*$/i;
const AUTH_FAILURE = /(?:wrong|incorrect|invalid)\s+password|no such character|password mismatch/i;
const EXISTING_SESSION_PROMPT = /\btake\s+over\b|already.{0,30}(?:playing|online|connected|logged|in use|session)|disconnect.{0,30}(?:old|existing|previous)|(?:existing|current).{0,30}(?:session|character)/i;
const AUTH_RETURN_PROMPT = /\b(?:press|hit)\s+(?:enter|return)\b[^\r\n]*\bto continue\b/i;
const PAGER_PROMPT = /--more--|\[?please type\s*\(?c\)?ontinue[^\]\r\n]*\]?|\[?hit return to continue[^\]\r\n]*\]?/i;
const RECONNECT_NOTICE = /\breconnect(?:ing|ion)?\b/i;
const AUTO_AFK_PROMPT = /<\s*AUTO-AFK(?:\s*\([^>]*\))?\s*>\s*(?:>\s*)?(?:\[Enter\])?\s*$/i;
const LOGIN_PROMPT_QUIET_MS = 300;
const ROM_PROMPT = /^\s*\d+\/\d+hp\b.*\b-?\d+mv\b.*>\s*$/i;

function hasRomPrompt(text) {
  const lastLine = text.replace(/\r/g, '').split('\n').at(-1) || '';
  return ROM_PROMPT.test(lastLine);
}

export class AgentTelnetSession {
  #password;
  #socketFactory;
  #fetch;
  #socket = null;
  #decoder = null;
  #connectAttempt = null;
  #authBuffer = '';
  #authenticated = false;
  #pending = null;
  #readBuffer = '';
  #readWaiter = null;

  constructor({
    username,
    password,
    profileId,
    apiOrigin = 'https://mud-indol.vercel.app',
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    encoding = 'windows-1252',
    connectTimeoutMs = 15000,
    commandTimeoutMs = 10000,
    socketFactory = net.createConnection,
    fetchImpl = fetch,
  } = {}) {
    this.username = typeof username === 'string' ? username.trim() : '';
    this.#password = typeof password === 'string' ? password : '';
    this.profileId = profileId;
    this.apiOrigin = new URL(apiOrigin).origin;
    this.host = host;
    this.port = port;
    this.encoding = encoding;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.#socketFactory = socketFactory;
    this.#fetch = fetchImpl;
  }

  async connect() {
    if (!this.username || !this.#password) throw new Error('MUD credentials are not configured.');
    if (/[\r\n\x00]/.test(this.username) || /[\r\n\x00]/.test(this.#password)) {
      throw new Error('MUD credentials are not configured.');
    }
    if (!isProfileId(this.profileId)) throw new Error('MUD_PROFILE_ID must be a valid UUID.');
    if (this.#socket) throw new Error('MUD session is already connected.');

    return new Promise((resolve, reject) => {
      const attempt = {
        resolve,
        reject,
        phase: 'waiting-name',
        autoAfkEnterSent: false,
        autoAfkTimer: null,
        timer: setTimeout(() => {
          const waitingFor = {
            'waiting-name': 'character-name prompt',
            'waiting-password': 'password prompt',
            'post-password': 'post-login MUD state',
            reconnecting: 'AUTO-AFK or game prompt',
            'auto-afk': 'stable AUTO-AFK prompt',
            'login-continuation': 'MUD prompt after login continuation',
            resuming: 'in-game prompt after leaving AUTO-AFK',
          }[attempt.phase] || 'authenticated game prompt';
          this.#failConnect(new Error(`Timed out waiting for MUD ${waitingFor}.`));
        }, this.connectTimeoutMs),
      };
      this.#connectAttempt = attempt;
      try {
        const socket = this.#socketFactory({ host: this.host, port: this.port });
        this.#socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        this.#decoder = new TelnetDecoder(
          bytes => { if (!socket.destroyed) socket.write(bytes); },
          () => {},
          this.encoding,
        );
        socket.on('data', bytes => this.#handleData(bytes));
        socket.on('error', () => this.#handleSocketFailure());
        socket.on('close', () => this.#handleSocketClose());
      } catch {
        this.#failConnect(new Error('Could not connect to the MUD.'));
      }
    });
  }

  async send(command) {
    if (!this.#authenticated) throw new Error('MUD session is not authenticated.');
    if (typeof command !== 'string' || command.length > 500 || /[\x00-\x1f\x7f]/.test(command)) {
      throw new Error('Invalid MUD command.');
    }
    if (this.#pending) throw new Error('Wait for the current MUD response before sending another command.');

    const output = await new Promise((resolve, reject) => {
      const pending = {
        output: '',
        lastPagerIndex: -1,
        resolve,
        reject,
        timer: setTimeout(() => this.#failPending(new Error('Timed out waiting for the MUD prompt.')), this.commandTimeoutMs),
      };
      this.#pending = pending;
      try {
        this.#writeLine(command);
      } catch {
        this.#failPending(new Error('Could not send the MUD command.'));
      }
    });

    const roomAfterMove = /^(?:n|north|s|south|e|east|w|west|u|up|d|down)$/i.test(command.trim())
      && parseObservation('look', output);
    const observationCommand = commandCategory(command) ? command : roomAfterMove ? 'look' : null;
    const persistence = observationCommand ? await this.#saveObservation(observationCommand, output) : null;
    return { output, persistence };
  }

  async read({ timeoutMs = this.commandTimeoutMs } = {}) {
    if (!this.#authenticated) throw new Error('MUD session is not authenticated.');
    if (this.#pending) throw new Error('A command response is being collected; await send() first.');
    if (this.#readBuffer) {
      const output = this.#readBuffer;
      this.#readBuffer = '';
      return output;
    }
    if (this.#readWaiter) throw new Error('Another read() is already waiting for MUD output.');

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#readWaiter = null;
          reject(new Error('Timed out waiting for unsolicited MUD output.'));
        }, timeoutMs),
      };
      this.#readWaiter = waiter;
    });
  }

  async disconnect() {
    this.#password = '';
    this.#authenticated = false;
    this.#authBuffer = '';
    if (this.#connectAttempt) this.#failConnect(new Error('MUD session disconnected.'));
    this.#failPending(new Error('MUD session disconnected.'));
    this.#failRead(new Error('MUD session disconnected.'));
    const socket = this.#socket;
    this.#socket = null;
    if (!socket || socket.destroyed) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  #writeLine(value) {
    if (!this.#socket || this.#socket.destroyed) throw new Error('MUD TCP connection is closed.');
    this.#socket.write(encodeCommand(value, this.encoding));
  }

  #handleData(bytes) {
    let text;
    try {
      text = this.#decoder.feed(bytes);
    } catch {
      this.#handleSocketFailure();
      return;
    }
    if (!text) return;
    if (!this.#authenticated) {
      this.#handleAuthentication(text);
      return;
    }

    if (this.#pending) {
      const pending = this.#pending;
      pending.output += text;
      if (pending.output.length > MAX_RESPONSE_LENGTH) {
        this.#failPending(new Error('MUD response exceeded the size limit.'));
        return;
      }
      const pager = PAGER_PROMPT.exec(pending.output);
      if (pager && pager.index >= pending.lastPagerIndex) {
        pending.lastPagerIndex = pending.output.length;
        try {
          this.#writeLine('c');
        } catch {
          this.#failPending(new Error('Could not continue MUD pagination.'));
        }
        return;
      }
      if (hasRomPrompt(pending.output)) this.#finishPending();
      return;
    }

    if (this.#readWaiter) {
      const waiter = this.#readWaiter;
      this.#readWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    } else {
      this.#readBuffer = (this.#readBuffer + text).slice(-MAX_RESPONSE_LENGTH);
    }
  }

  #handleAuthentication(text) {
    const attempt = this.#connectAttempt;
    if (!attempt) return;
    this.#authBuffer = (this.#authBuffer + text).slice(-MAX_RESPONSE_LENGTH);
    const end = this.#authBuffer.trimEnd();

    if (attempt.phase === 'waiting-name' && NAME_PROMPT.test(end)) {
      attempt.phase = 'waiting-password';
      try {
        this.#writeLine(this.username);
        this.#authBuffer = '';
      } catch {
        this.#failConnect(new Error('Could not send MUD login.'));
      }
      return;
    }
    if (attempt.phase === 'waiting-password' && PASSWORD_PROMPT.test(end)) {
      attempt.phase = 'post-password';
      const password = this.#password;
      this.#password = '';
      try {
        this.#writeLine(password);
        this.#authBuffer = '';
      } catch {
        this.#failConnect(new Error('Could not complete MUD authentication.'));
      }
      return;
    }
    if (attempt.phase === 'waiting-name' || attempt.phase === 'waiting-password') return;
    if (AUTH_FAILURE.test(this.#authBuffer)) {
      this.#failConnect(new Error('MUD authentication failed.'));
      return;
    }
    if (EXISTING_SESSION_PROMPT.test(this.#authBuffer)) {
      this.#failConnect(new Error('MUD requested confirmation for a possible existing session; refusing to take over automatically.'));
      return;
    }
    if (hasRomPrompt(this.#authBuffer)) {
      this.#authenticated = true;
      this.#authBuffer = '';
      this.#finishConnect();
      return;
    }
    if (AUTO_AFK_PROMPT.test(end) && !attempt.autoAfkEnterSent) {
      clearTimeout(attempt.autoAfkTimer);
      attempt.phase = 'auto-afk';
      attempt.autoAfkTimer = setTimeout(() => {
        if (this.#connectAttempt !== attempt || attempt.phase !== 'auto-afk') return;
        attempt.phase = 'resuming';
        attempt.autoAfkEnterSent = true;
        this.#authBuffer = '';
        try {
          this.#writeLine('');
        } catch {
          this.#failConnect(new Error('Could not resume the MUD character.'));
        }
      }, LOGIN_PROMPT_QUIET_MS);
      return;
    }
    if (attempt.phase === 'auto-afk') {
      clearTimeout(attempt.autoAfkTimer);
      attempt.autoAfkTimer = null;
      attempt.phase = 'reconnecting';
    }
    if (AUTH_RETURN_PROMPT.test(this.#authBuffer) || PAGER_PROMPT.test(this.#authBuffer)) {
      const response = AUTH_RETURN_PROMPT.test(this.#authBuffer) ? '' : 'c';
      attempt.phase = 'login-continuation';
      this.#authBuffer = '';
      try {
        this.#writeLine(response);
      } catch {
        this.#failConnect(new Error('Could not continue MUD login.'));
      }
      return;
    }
    if (attempt.phase === 'post-password' && RECONNECT_NOTICE.test(this.#authBuffer)) attempt.phase = 'reconnecting';
  }

  async #saveObservation(command, text) {
    let response;
    try {
      response = await this.#fetch(new URL('/api/knowledge', this.apiOrigin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: this.profileId, command, text }),
      });
    } catch (error) {
      return { saved: false, error: 'Knowledge API request failed.', errorType: error instanceof Error ? error.name : 'UnknownError' };
    }
    if (response.ok) return { saved: true };

    const body = await response.json().catch(() => null);
    return {
      saved: false,
      status: response.status,
      code: typeof body?.code === 'string' ? body.code : null,
      error: typeof body?.error === 'string' ? body.error : 'Knowledge API rejected the observation.',
    };
  }

  #finishConnect(error) {
    const attempt = this.#connectAttempt;
    if (!attempt) return;
    this.#connectAttempt = null;
    clearTimeout(attempt.timer);
    clearTimeout(attempt.autoAfkTimer);
    if (error) attempt.reject(error);
    else attempt.resolve(`connected/authenticated as ${this.username}`);
  }

  #failConnect(error) {
    this.#finishConnect(error);
    this.#password = '';
    this.#socket?.destroy();
  }

  #finishPending() {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.resolve(pending.output);
  }

  #failPending(error) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #failRead(error) {
    const waiter = this.#readWaiter;
    if (!waiter) return;
    this.#readWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  #handleSocketFailure() {
    if (this.#connectAttempt) this.#failConnect(new Error('MUD connection failed.'));
    this.#authenticated = false;
    this.#failPending(new Error('MUD TCP connection failed before the response completed.'));
    this.#failRead(new Error('MUD TCP connection failed.'));
  }

  #handleSocketClose() {
    if (this.#connectAttempt) this.#failConnect(new Error('MUD disconnected before authentication completed.'));
    this.#authenticated = false;
    this.#failPending(new Error('MUD connection closed before the response completed.'));
    this.#failRead(new Error('MUD connection closed.'));
  }
}
