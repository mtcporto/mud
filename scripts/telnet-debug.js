import net from 'node:net';
import { createInterface } from 'node:readline';
import { createSecretRedactor } from '../lib/secret-redactor.js';
import { TelnetDecoder, encodeCommand } from '../lib/telnet.js';

const HOST = 'mud.fataldimensions.nl';
const PORT = 4000;
const NAME_PROMPT = /by what name do you wish to be known\?\s*$/i;
const PASSWORD_PROMPT = /password\s*:\s*$/i;

let username = process.env.MUD_USERNAME?.trim() || '';
let password = process.env.MUD_PASSWORD || '';
if (!username || !password || /[\r\n\x00]/.test(username) || /[\r\n\x00]/.test(password)) {
  console.error('MUD credentials are not configured correctly.');
  process.exit(1);
}

let phase = 'waiting-name';
let authBuffer = '';
let redactor;
let input;
let authTimer;
let captureTimer;
let connectTimer;
let finished = false;
const socket = net.createConnection({ host: HOST, port: PORT });

function finish(message) {
  if (finished) return;
  finished = true;
  clearTimeout(connectTimer);
  clearTimeout(authTimer);
  clearTimeout(captureTimer);
  redactor?.flush();
  if (message) console.log(message);
  input?.close();
  if (!socket.destroyed) socket.destroy();
}

function writeCommand(command) {
  try {
    socket.write(encodeCommand(command, 'windows-1252'));
  } catch {
    throw new Error('Input is not supported by the MUD encoding.');
  }
}

function startManualInput() {
  input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  if (process.stdin.isTTY) {
    input.setPrompt('MUD> ');
    input.prompt();
  }
  input.on('line', line => {
    try {
      if (line.trim() === ':quit') {
        socket.end();
        return;
      }
      writeCommand(line);
      if (process.stdin.isTTY) input.prompt();
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Could not send input.');
    }
  });
  input.on('close', () => {
    if (process.stdin.isTTY && !socket.destroyed) socket.end();
  });
  if (!process.stdin.isTTY) {
    captureTimer = setTimeout(() => {
      finish('Diagnostic capture ended; use an interactive terminal to answer MUD prompts.');
    }, 12000);
  }
}

const decoder = new TelnetDecoder(
  bytes => { if (!socket.destroyed) socket.write(bytes); },
  () => {},
  'windows-1252',
);

socket.setNoDelay(true);
socket.setKeepAlive(true, 30000);
socket.on('connect', () => {
  clearTimeout(connectTimer);
  clearTimeout(authTimer);
  console.log(`TCP connected to ${HOST}:${PORT}. Waiting for login prompts.`);
  authTimer = setTimeout(() => finish('Timed out waiting for a MUD login prompt.'), 20000);
});
socket.on('data', bytes => {
  let text;
  try {
    text = decoder.feed(bytes);
  } catch {
    finish('Could not decode the MUD stream.');
    return;
  }
  if (!text || finished) return;
  if (phase === 'post-password') {
    redactor.write(text);
    return;
  }

  authBuffer = (authBuffer + text).slice(-4000);
  const end = authBuffer.trimEnd();
  if (phase === 'waiting-name' && NAME_PROMPT.test(end)) {
    try {
      writeCommand(username);
      username = '';
      authBuffer = '';
      phase = 'waiting-password';
      console.log('Name prompt detected; username sent.');
    } catch (error) {
      finish(error instanceof Error ? error.message : 'Could not send MUD login.');
    }
    return;
  }
  if (phase === 'waiting-password' && PASSWORD_PROMPT.test(end)) {
    let passwordBytes;
    try {
      passwordBytes = encodeCommand(password, 'windows-1252');
    } catch {
      finish('Password is not supported by the MUD encoding.');
      return;
    }
    redactor = createSecretRedactor(password, text => process.stdout.write(text));
    password = '';
    authBuffer = '';
    phase = 'post-password';
    clearTimeout(authTimer);
    socket.write(passwordBytes);
    console.log('\nPassword sent. Raw decoded server output follows; password echoes are masked.');
    startManualInput();
  }
});
socket.on('error', () => finish('Telnet connection failed.'));
socket.on('close', () => finish('Telnet connection closed.'));
socket.on('end', () => finish('MUD closed the Telnet stream.'));
process.on('SIGINT', () => finish('\nDebug session stopped.'));

connectTimer = setTimeout(() => finish('Timed out connecting to the MUD.'), 10000);
