// Synthetic game for local browser verification. Never connects to a real MUD.
import net from 'node:net';
import { once } from 'node:events';
import { createMudServer } from '../server.js';
const game=net.createServer(socket=>{socket.write('Bem-vindo ao mundo de teste!\r\nUma sala de pedra. Saída: north.\r\n');let buffer='';socket.on('data',bytes=>{buffer+=bytes.toString();let at;while((at=buffer.indexOf('\r\n'))>=0){const command=buffer.slice(0,at);buffer=buffer.slice(at+2);socket.write(command==='north'?'Você chegou ao jardim.\r\n':'Uma sala de pedra. Saída: north.\r\n');}});});
game.listen(0,'127.0.0.1');await once(game,'listening');
const app=createMudServer({targets:[{id:'test',name:'Mundo de teste local',host:'example.com',port:game.address().port}],resolveTarget:async()=> '127.0.0.1',fetchImpl:async()=>new Response(JSON.stringify({model:'gpt-4o',choices:[{finish_reason:'stop',message:{content:JSON.stringify({explanation:'A saída ao norte leva a uma nova área.',command:'north'})}}]}))});
app.server.listen(3123,'127.0.0.1',()=>console.log('Local synthetic MUD: http://127.0.0.1:3123'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.shutdown();game.close();});
