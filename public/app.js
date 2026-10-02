const $ = id => document.getElementById(id);
let connected = false, stream, started = 0, busy = false, suggestion = null, history = [], cursor = 0, revision = 0;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function discard() { suggestion = null; $('suggestion').hidden = true; }
function controls() {
  $('connect').disabled = connected || !$('target').value;
  $('disconnect').disabled = !connected; $('target').disabled = connected;
  for (const id of ['command','send','sharing']) $(id).disabled = !connected;
  $('suggest').disabled = !connected || !$('sharing').checked || $('sensitive').checked || busy;
  $('status').textContent = connected ? 'Conectado' : 'Desconectado'; $('status').classList.toggle('online', connected);
}
function privateMode(enabled) { $('sensitive').checked = enabled; $('command').type = enabled ? 'password' : 'text'; }
function disconnected() { connected = false; stream?.close(); stream = null; $('sharing').checked = false; privateMode(false); history = []; cursor = 0; revision++; discard(); controls(); }
function output(text, runs = [{ text }]) {
  const el = $('terminal');
  const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const span = document.createElement('span');
    span.textContent = run.text;
    const validColor = value => /^#[0-9a-f]{6}$/i.test(value || '');
    const foreground = validColor(run.foreground) ? run.foreground : '#c0d3cf';
    const background = validColor(run.background) ? run.background : '#101820';
    if (run.foreground || run.inverse) span.style.color = run.inverse ? background : foreground;
    if (run.background || run.inverse) span.style.backgroundColor = run.inverse ? foreground : background;
    if (run.bold) span.style.fontWeight = '700';
    if (run.italic) span.style.fontStyle = 'italic';
    if (run.underline) span.style.textDecoration = 'underline';
    fragment.append(span);
  }
  el.append(fragment);
  // Bound both characters and DOM nodes, preserving the style of retained text.
  let excess = el.textContent.length - 100000;
  while (el.firstChild && (excess > 0 || el.childNodes.length > 2000)) {
    const first = el.firstChild, length = first.textContent.length;
    if (el.childNodes.length <= 2000 && length > excess) { first.textContent = first.textContent.slice(excess); break; }
    first.remove(); excess -= length;
  }
  if (bottom) el.scrollTop = el.scrollHeight;
}
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) disconnected(); throw new Error(value.error || 'Falha na solicitação.'); }
  return value;
}
function attach() {
  stream?.close(); stream = new EventSource('/api/events');
  stream.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.type === 'output') { output(data.text, data.runs); revision++; discard(); }
    if (data.type === 'privacy') { privateMode(data.sensitive); $('sharing').checked = data.sharing; revision++; discard(); controls(); }
    if (data.type === 'closed') { disconnected(); notice(data.message); }
  };
  stream.addEventListener('ready', () => notice('Conexão ativa. Você está no controle.'));
  stream.onerror = async () => { if (!connected) return; notice('Recuperando o canal de mensagens…'); try { await api('session'); } catch (error) { notice(error.message, true); } };
}
$('connect').onclick = async () => {
  $('connect').disabled = true; notice('Conectando ao mundo…');
  try { await api('connect', {target:$('target').value}); connected = true; started = Date.now(); $('terminal').textContent = ''; $('sharing').checked = false; privateMode(false); attach(); $('command').disabled = false; $('command').focus(); }
  catch (error) { notice(error.message, true); } finally { controls(); }
};
$('disconnect').onclick = async () => { try { await api('disconnect', {}); disconnected(); notice('Conexão encerrada.'); } catch (error) { notice(error.message, true); } };
async function send(command) {
  const sensitive = $('sensitive').checked;
  revision++; discard();
  if (!sensitive && command) { history.push(command); history = history.slice(-100); cursor = history.length; output(`\n› ${command}\n`); }
  const result = await api('command', {command, sensitive}); $('sharing').checked = result.sharing; controls();
}
$('command-form').onsubmit = async event => { event.preventDefault(); const command = $('command').value; $('command').value = ''; try { await send(command); } catch (error) { notice(error.message, true); } };
$('command').onkeydown = event => { if ($('sensitive').checked || !['ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); cursor = Math.max(0, Math.min(history.length, cursor + (event.key === 'ArrowUp' ? -1 : 1))); $('command').value = history[cursor] || ''; };
$('sensitive').onchange = async () => {
  privateMode($('sensitive').checked); revision++; discard();
  if ($('sensitive').checked) { $('sharing').checked = false; controls(); try { await api('privacy', {sharing:false}); } catch (error) { notice(error.message, true); } }
  controls();
};
$('sharing').onchange = async () => {
  const sharing = $('sharing').checked; revision++; discard(); $('sharing').disabled = true;
  try { await api('privacy', {sharing}); if (sharing) privateMode(false); notice(sharing ? 'Análise ativada. Use look para receber uma descrição atual.' : 'Análise desativada. Contexto apagado.'); }
  catch (error) { $('sharing').checked = false; notice(error.message, true); } finally { controls(); }
};
$('suggest').onclick = async () => {
  busy = true; discard(); controls(); const requestedRevision = revision; notice('O copiloto está lendo o cenário…');
  try { const result = await api('suggest', {}); if (revision !== requestedRevision || !connected || !$('sharing').checked) { notice('O cenário mudou. Peça uma nova sugestão.'); return; } suggestion = result.command; $('explanation').textContent = result.explanation; $('suggested-command').textContent = result.command; $('suggestion').hidden = false; notice('Sugestão pronta. Revise antes de enviar.'); }
  catch (error) { notice(error.message, true); } finally { busy = false; controls(); }
};
$('approve').onclick = async () => { if (!suggestion || !connected || !$('sharing').checked || $('sensitive').checked) return; try { await send(suggestion); } catch (error) { notice(error.message, true); } };
$('discard').onclick = discard; $('clear').onclick = () => { $('terminal').textContent = ''; };
setInterval(() => { const seconds = connected ? Math.floor((Date.now()-started)/1000) : 0; $('duration').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; }, 1000);
try {
  const config = await api('config');
  for (const target of config.targets) { const option = document.createElement('option'); option.value = target.id; option.textContent = `${target.name} (${target.host}:${target.port})`; $('target').append(option); }
  try { const session = await api('session'); connected = session.connected; $('target').value = session.target; $('sharing').checked = session.sharing; privateMode(session.sensitive); started = Date.now(); if (connected) attach(); } catch { /* No existing session is normal. */ }
  controls();
} catch { notice('A ponte do MUD está indisponível. Inicie o servidor Node para jogar.', true); }
