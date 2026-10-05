const $ = id => document.getElementById(id);
const MAX_TURNS = 1000;
const MAX_HISTORY_LENGTH = 12000;
const MIN_DECISION_INTERVAL_MS = 4000;
const BLOCKED_COMMAND = /^(?:password|passwd|login|quit|logout|suicide|shutdown|reboot|delete|purge)\b/i;

let gameReady = false;
let isAdmin = false;
let preLoginOutput = '';
let agentRunning = false;
let agentOutput = '';
let agentHistory = '';
let agentController = null;
let agentWaiter = null;
let quietTimer = null;
let agentStatusNote = '';
let lastDecisionAt = 0;

function isSafeCommand(command) {
  const value = typeof command === 'string' ? command.trim() : '';
  return value.length > 0
    && value.length <= 200
    && !/[\x00-\x1f\x7f;]/.test(value)
    && !/^[!/#]/.test(value)
    && !BLOCKED_COMMAND.test(value);
}

function hasGamePrompt(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  return lines.some(line => /\b\d+\/\s*\d+hp\b.*\b-?\d+mv\b.*>\s*$/i.test(line));
}

function isPasswordPrompt(text) {
  const lastLine = text.replace(/\r/g, '').split('\n').at(-1) || '';
  return /(?:password|passphrase|senha)\s*[:?>]?\s*$/i.test(lastLine);
}

function updateControls() {
  const socket = window.mudAgentSocket?.();
  const connected = socket?.readyState === WebSocket.OPEN;
  const panel = $('agent-control');
  const button = $('agent-toggle');
  panel.hidden = !isAdmin;
  button.disabled = !isAdmin || (!agentRunning && (!connected || !gameReady || $('sensitive').checked));
  button.textContent = agentRunning ? 'Desligar agente Luna' : 'Ligar agente Luna';
  button.setAttribute('aria-pressed', String(agentRunning));
  button.classList.toggle('running', agentRunning);
  $('command').disabled = !connected || agentRunning;
  $('send').disabled = !connected || agentRunning;
  $('sensitive').disabled = !connected || agentRunning;
  $('suggest').disabled = agentRunning || !($('sharing').checked && connected);
  if (agentRunning) {
    $('agent-status').textContent = `Agente ativo · Gemma · ação ${Math.max(1, agentHistory.split('\n\n> ').length)}/${MAX_TURNS}. Mantenha esta aba aberta.`;
  } else if (!connected) {
    $('agent-status').textContent = 'Conecte Luna ao MUD para habilitar o agente.';
  } else if (!gameReady) {
    $('agent-status').textContent = 'Faça login e aguarde o prompt do personagem no jogo.';
  } else {
    $('agent-status').textContent = agentStatusNote || 'Pronto. A aba e a conexão precisam permanecer abertas.';
  }
}

function settleAfterQuiet() {
  if (!agentWaiter || !agentOutput.trim()) return;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    const waiter = agentWaiter;
    if (!waiter) return;
    agentWaiter = null;
    clearTimeout(waiter.timeout);
    const output = agentOutput;
    agentOutput = '';
    waiter.resolve(output);
  }, 1200);
}

function waitForOutput() {
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        if (agentWaiter !== waiter) return;
        agentWaiter = null;
        clearTimeout(quietTimer);
        reject(new Error('O jogo não respondeu ao comando em 45 segundos.'));
      }, 45000),
    };
    agentWaiter = waiter;
    settleAfterQuiet();
  });
}

function receiveGameOutput(text) {
  const clean = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (!clean) return;
  if (isPasswordPrompt((preLoginOutput + clean).slice(-1000))) {
    gameReady = false;
    preLoginOutput = '';
    if (agentRunning) stopAgent('Agente pausado: o jogo voltou a pedir senha.');
    updateControls();
    return;
  }
  if (!gameReady) {
    preLoginOutput = (preLoginOutput + clean).slice(-3000);
    if (hasGamePrompt(preLoginOutput)) {
      gameReady = true;
      preLoginOutput = '';
      updateControls();
    }
    return;
  }
  if (!agentRunning) return;
  agentOutput = `${agentOutput}${clean}`.slice(-MAX_HISTORY_LENGTH);
  settleAfterQuiet();
}

function stopAgent(message = 'Agente desligado.') {
  agentRunning = false;
  agentController?.abort();
  agentController = null;
  clearTimeout(quietTimer);
  if (agentWaiter) {
    const waiter = agentWaiter;
    agentWaiter = null;
    clearTimeout(waiter.timeout);
    const output = agentOutput;
    agentOutput = '';
    waiter.resolve(output);
  }
  agentStatusNote = message;
  updateControls();
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sendAgentCommand(command) {
  return isSafeCommand(command) && Boolean(window.mudAgentSendCommand?.(command));
}

async function runAgent() {
  if (!isAdmin || !gameReady || window.mudAgentSocket?.()?.readyState !== WebSocket.OPEN) {
    updateControls();
    return;
  }
  agentRunning = true;
  agentStatusNote = '';
  agentHistory = '';
  updateControls();
  try {
    agentOutput = '';
    if (!sendAgentCommand('look')) throw new Error('A conexão com o MUD foi encerrada.');
    let latestOutput = await waitForOutput();
    agentHistory = `> look\n${latestOutput}`;

    for (let turn = 0; turn < MAX_TURNS && agentRunning; turn += 1) {
      const waitMs = MIN_DECISION_INTERVAL_MS - (Date.now() - lastDecisionAt);
      if (waitMs > 0) await delay(waitMs);
      if (!agentRunning) break;

      const controller = new AbortController();
      agentController = controller;
      const timeout = setTimeout(() => controller.abort(), 65000);
      lastDecisionAt = Date.now();
      let response;
      try {
        response = await fetch('/api/agent-decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: localStorage.getItem('mud-copilot-profile'), context: agentHistory }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        if (agentController === controller) agentController = null;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Falha na decisão do agente.');
      if (!agentRunning) break;
      if (!isSafeCommand(result.command) || typeof result.explanation !== 'string') {
        throw new Error('O agente sugeriu uma ação inválida; execução pausada.');
      }
      $('agent-status').textContent = `Gemma: ${result.explanation}`;
      agentOutput = '';
      if (!sendAgentCommand(result.command)) throw new Error('A ação não foi enviada ao MUD.');
      latestOutput = await waitForOutput();
      agentHistory = `${agentHistory}\n\n> ${result.command}\n${latestOutput}`.slice(-MAX_HISTORY_LENGTH);
      if (/\bLevel\s*:\s*(?:10|[1-9]\d+)\b/i.test(latestOutput)) {
        stopAgent('Nível 10 confirmado pelo jogo.');
        return;
      }
    }
    if (agentRunning) stopAgent(`Agente pausado após o limite de ${MAX_TURNS} ações.`);
  } catch (error) {
    if (agentRunning) {
      const message = error instanceof Error && error.name !== 'AbortError'
        ? error.message
        : 'Agente desligado.';
      stopAgent(message);
    }
  } finally {
    if (agentRunning) stopAgent('Agente desligado.');
  }
}

function toggleAgent() {
  if (agentRunning) stopAgent('Agente desligado pelo usuário.');
  else void runAgent();
}

const nativeConnect = $('connect').onclick;
$('connect').onclick = () => {
  gameReady = false;
  preLoginOutput = '';
  agentStatusNote = '';
  nativeConnect();
  updateControls();
};
$('agent-toggle').onclick = toggleAgent;
window.addEventListener('mud-google-auth', event => {
  isAdmin = event.detail?.isAdmin === true;
  if (!isAdmin && agentRunning) stopAgent('Agente pausado: sessão de administrador encerrada.');
  updateControls();
});
window.addEventListener('mud-agent-output', event => receiveGameOutput(event.detail));
window.addEventListener('mud-agent-connected', updateControls);
window.addEventListener('mud-agent-disconnected', () => {
  gameReady = false;
  preLoginOutput = '';
  if (agentRunning) stopAgent('Agente pausado: conexão com o MUD encerrada.');
  updateControls();
});
const sensitiveChange = $('sensitive').onchange;
$('sensitive').onchange = event => {
  if ($('sensitive').checked && agentRunning) stopAgent('Agente pausado durante entrada privada.');
  sensitiveChange?.(event);
  updateControls();
};
updateControls();
