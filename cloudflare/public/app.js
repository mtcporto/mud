const terminal = document.querySelector('#terminal'), input = document.querySelector('#command'), button = document.querySelector('button'), status = document.querySelector('#status');
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`); ws.binaryType = 'arraybuffer';
function write(value) { terminal.textContent += value; terminal.scrollTop = terminal.scrollHeight; }
ws.onopen = () => { status.textContent = 'Conectado ao Fatal Dimensions'; input.disabled = button.disabled = false; input.focus(); };
ws.onmessage = event => write(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
ws.onerror = () => { status.textContent = 'Falha na conexão'; };
ws.onclose = () => { status.textContent = 'Conexão encerrada'; input.disabled = button.disabled = true; };
document.querySelector('form').onsubmit = event => { event.preventDefault(); const command = input.value; input.value = ''; if (!command || ws.readyState !== WebSocket.OPEN) return; write(`\n› ${command}\n`); ws.send(command); };
