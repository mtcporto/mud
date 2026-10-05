import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { TelnetDecoder, encodeCommand } from '../lib/telnet.js';
import { isPublicIPv4, resolvePublicTarget, parseTargets } from '../lib/network.js';
import { suggestCommand } from '../lib/copilot.js';
import { createMudServer } from '../server.js';

const response = (command = 'look', extra = {}) => new Response(JSON.stringify({model:'gpt-4o-2024-11-20', choices:[{finish_reason:'stop',message:{content:'```json\n'+JSON.stringify({explanation:'Observe a sala.',command})+'\n```'}}], ...extra}));
test('Telnet preserves split UTF-8, strips split ANSI and negotiates split options', () => {
  const replies = [], echo = [];
  const decoder = new TelnetDecoder(bytes => replies.push([...bytes]), value => echo.push(value));
  assert.equal(decoder.feed(Buffer.from([255,251])), '');
  assert.equal(decoder.feed(Buffer.from([1,27,91,51])), '');
  assert.equal(decoder.feed(Buffer.from('1mOlá\x1b[0m\r\n')), 'Olá\n');
  const bytes = Buffer.from('ação');
  assert.equal(decoder.feed(bytes.subarray(0,2))+decoder.feed(bytes.subarray(2)), 'ação');
  assert.deepEqual(replies, [[255,253,1]]); assert.deepEqual(echo,[true]);
  assert.equal(decoder.feed(Buffer.from([255,250,24,1,255])), '');
  assert.equal(decoder.feed(Buffer.from([240,65])), 'A');
});
test('destination restrictions reject private, reserved and IPv6 addresses', async () => {
  for (const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','192.168.0.1','172.16.1.1','100.64.1.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1']) assert.equal(isPublicIPv4(ip),false,ip);
  assert.equal(isPublicIPv4('8.8.8.8'),true);
  await assert.rejects(resolvePublicTarget('127.0.0.1'));
  assert.throws(() => parseTargets('[{"id":"x","name":"x","host":"host","port":0}]'));
});
test('outbound Telnet handles legacy accents, IAC escaping and blank commands',()=>{
  assert.deepEqual([...encodeCommand('açãoÿ','windows-1252')],[97,231,227,111,255,255,13,10]);
  assert.deepEqual([...encodeCommand('')],[13,10]);
  assert.throws(()=>encodeCommand('😀','windows-1252'));
});
test('copilot uses the configured OpenAI-compatible endpoint/model and rejects unsafe or incomplete output', async () => {
  const result = await suggestCommand('Sala fictícia.', async (url, options) => {
    assert.equal(url,'https://copilot-mtcporto.vercel.app/v1/chat/completions');
    assert.equal(options.headers.Authorization,undefined); assert.equal(JSON.parse(options.body).model,'gpt-4o');
    return response();
  });
  assert.equal(result.command,'look');
  const configured = await suggestCommand('Sala fictícia.', async (url, options) => {
    assert.equal(url,'https://ai.example/api/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model,'example-model');
    return response('north',{model:'example-model'});
  }, undefined, {baseUrl:'https://ai.example/api/v1',model:'example-model'});
  assert.equal(configured.command,'north');
  await assert.rejects(suggestCommand('room',async () => response(),undefined,{baseUrl:'http://example.com',model:'model'}));
  for (const command of ['look\nnorth','look;north','delete character','']) await assert.rejects(suggestCommand('room',async () => response(command)));
  await assert.rejects(suggestCommand('room',async () => response('look',{model:'other'})));
  await assert.rejects(suggestCommand('room',async () => response('look',{choices:[{finish_reason:'length'}]})));
});
test('HTTP/TCP session: greeting replay, isolation, origins, opt-in AI and private commands', async t => {
  const commands = []; const peers = new Set(); let aiPayload;
  const game = net.createServer(socket => { peers.add(socket); socket.on('close',()=>peers.delete(socket)); socket.write('Welcome to the test room!\r\n'); let buffer=''; socket.on('data',bytes=>{ buffer+=bytes.toString(); let at; while((at=buffer.indexOf('\r\n'))>=0){const command=buffer.slice(0,at);buffer=buffer.slice(at+2);commands.push(command);socket.write('Stone room. Exits: north.\r\n');} }); });
  game.listen(0,'127.0.0.1'); await once(game,'listening');
  const app = createMudServer({targets:[{id:'test',name:'Test',host:'example.com',port:game.address().port}],resolveTarget:async()=> '127.0.0.1',fetchImpl:async (url, options)=>{aiPayload=JSON.parse(options.body); return response();}});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(async()=>{await app.shutdown();for(const peer of peers)peer.destroy();await new Promise(resolve=>game.close(resolve));});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  const post=(path,data,headers={})=>fetch(base+'/api/'+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(data)});
  assert.equal((await post('connect',{target:'test'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('command',{command:'look'})).status,401);
  assert.equal((await post('connect',{target:'unknown',host:'127.0.0.1',port:22})).status,400);
  const connected=await post('connect',{target:'test'});assert.equal(connected.status,201);cookie=connected.headers.get('set-cookie').split(';')[0];assert.match(connected.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await post('command',{command:'look'},{Cookie:'mud_session=forged'})).status,401);
  const abort = new AbortController(); const events=await fetch(base+'/api/events',{headers:{Cookie:cookie},signal:abort.signal});const reader=events.body.getReader();let data='';
  while(!data.includes('Welcome')) data+=new TextDecoder().decode((await reader.read()).value);
  assert.match(data,/Welcome to the test room/);abort.abort();await reader.cancel().catch(()=>{});
  assert.equal((await post('suggest',{})).status,409);
  assert.equal((await post('privacy',{sharing:true})).status,200);
  assert.equal((await post('command',{command:'look\nnorth'})).status,400);
  assert.equal((await post('command',{command:'x'.repeat(5000)})).status,413);
  assert.equal((await post('command',{command:''})).status,200);
  // Wait on actual game output rather than a fixed delay.
  const abort2 = new AbortController();const events2=await fetch(base+'/api/events',{headers:{Cookie:cookie},signal:abort2.signal});const reader2=events2.body.getReader();data='';while(!data.includes('Stone room'))data+=new TextDecoder().decode((await reader2.read()).value);
  const suggestion=await post('suggest',{});assert.equal(suggestion.status,200);assert.equal((await suggestion.json()).command,'look');assert.deepEqual(commands,['']);assert.match(aiPayload.messages[1].content,/Stone room/);assert.doesNotMatch(aiPayload.messages[1].content,/Welcome/);
  assert.equal((await post('command',{command:'fake-test-password',sensitive:true})).status,200);
  assert.equal((await post('suggest',{})).status,409);
  assert.equal((await post('disconnect',{})).status,200);abort2.abort();await reader2.cancel().catch(()=>{});
  assert.equal((await fetch(base+'/api/session',{headers:{Cookie:cookie}})).status,401);
});
test('failed DNS is bounded and does not crash the process',async t=>{
  const app=createMudServer({resolveTarget:()=>new Promise(()=>{}),connectTimeout:25});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.server.address().port}`;
  const result=await fetch(base+'/api/connect',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({target:'fatal'})});assert.equal(result.status,502);
});
