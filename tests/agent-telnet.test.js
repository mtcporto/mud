import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { AgentTelnetSession } from '../lib/agent-telnet.js';
import { parseObservation } from '../lib/observations.js';

const PROFILE_ID = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';

test('agent Telnet authenticates privately, handles fragmented prompts and paging, persists look, and disconnects', async t => {
  const fakePassword = 'fixture-only-password';
  const received = [];
  const peers = new Set();
  let apiPayload;
  const game = net.createServer(socket => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    let input = '';
    let passwordSent = false;
    socket.write('Fixture banner must not escape.\r\nBy what name do you wish to be known? ');
    socket.on('data', bytes => {
      input += bytes.toString('latin1');
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const command = input.slice(0, end);
        input = input.slice(end + 2);
        received.push(command);
        if (command === 'Luna') {
          socket.write('Pass');
          setTimeout(() => socket.write('word: '), 5);
        } else if (command === fakePassword) {
          passwordSent = true;
          socket.write('Login complete.\r\n131/131hp 121/121ma 30mv | N > ');
        } else if (passwordSent && command === 'look') {
          socket.write('The Test Room\r\nA quiet room.\r\n[Please type (c)');
          setTimeout(() => socket.write('ontinue...]\r\n'), 5);
        } else if (passwordSent && command === 'c') {
          socket.write('A second page.\r\n131/131hp 121/121ma 30mv | N > ');
          setTimeout(() => socket.write('An unsolicited tell.\r\n'), 5);
        }
      }
    });
  });
  game.listen(0, '127.0.0.1');
  await once(game, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => game.close(resolve));
  });

  const session = new AgentTelnetSession({
    username: 'Luna',
    password: fakePassword,
    profileId: PROFILE_ID,
    host: '127.0.0.1',
    port: game.address().port,
    connectTimeoutMs: 1000,
    commandTimeoutMs: 1000,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/api/knowledge');
      apiPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ saved: true }), { status: 201 });
    },
  });
  t.after(() => session.disconnect());

  assert.equal(await session.connect(), 'connected/authenticated as Luna');
  const result = await session.send('look');
  assert.deepEqual(received, ['Luna', fakePassword, 'look', 'c']);
  assert.match(result.output, /The Test Room/);
  assert.match(result.output, /A second page/);
  assert.doesNotMatch(result.output, /Fixture banner|Password|Login complete|fixture-only-password/);
  assert.deepEqual(apiPayload, {
    profile: PROFILE_ID,
    command: 'look',
    text: result.output,
  });
  assert.equal(parseObservation(apiPayload.command, apiPayload.text)?.data.name, 'The Test Room');
  assert.doesNotMatch(apiPayload.text, /Fixture banner|Password|Login complete|fixture-only-password/);
  assert.deepEqual(result.persistence, { saved: true });
  assert.equal(await session.read(), 'An unsolicited tell.\n');
  await session.disconnect();
  assert.equal(peers.size, 0);
});

test('agent Telnet refuses missing credentials without opening a socket', async () => {
  const session = new AgentTelnetSession({
    username: 'Luna',
    password: '',
    profileId: PROFILE_ID,
    socketFactory: () => { throw new Error('socket must not be opened'); },
  });
  await assert.rejects(session.connect(), { message: 'MUD credentials are not configured.' });
});
