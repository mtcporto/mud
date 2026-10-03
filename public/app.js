const $ = id => document.getElementById(id);
const BRIDGE = 'wss://mud-fataldimensions.mosaicoworkers.workers.dev/api/ws';
let socket;
function setStatus(text, online = false) { $('status').textContent = text; $('status').classList.toggle('online', online); }
function appendText(text) { const terminal = $('terminal'); const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); terminal.textContent = (terminal.textContent + clean).slice(-100000); terminal.scrollTop = terminal.scrollHeight; }
function connectedControls(connected) { $('connect').disabled = connected; $('disconnect').disabled = !connected; $('command').disabled = $('send').disabled = !connected; }
function connect() { setStatus('Conectando…'); $('connect').disabled = true; socket = new WebSocket(BRIDGE); socket.binaryType = 'arraybuffer'; socket.onopen = () => { setStatus('Conectado ao Fatal Dimensions', true); connectedControls(true); $('command').focus(); }; socket.onmessage = event => appendText(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)); socket.onerror = () => setStatus('Falha na ponte Cloudflare'); socket.onclose = () => { setStatus('Desconectado'); connectedControls(false); }; }
$('target').innerHTML = '<option value="fatal">Fatal Dimensions (mud.fataldimensions.nl:4000)</option>';
$('connect').onclick = connect; $('disconnect').onclick = () => socket?.close();
$('command-form').onsubmit = event => { event.preventDefault(); const command = $('command').value; $('command').value = ''; if (command && socket?.readyState === WebSocket.OPEN) socket.send(command); };
$('clear').onclick = () => { $('terminal').textContent = ''; }; connectedControls(false); $('connect').disabled = false; setStatus('Desconectado');
