const $ = id => document.getElementById(id);
const status = $('google-auth-status');
const login = $('google-login');
const logout = $('google-logout');
const messages = {
  cancelled: 'Login cancelado. Você ainda pode entrar com o Google.',
  invalid_state: 'A verificação do login expirou ou falhou. Tente novamente.',
  token_exchange: 'O Google não concluiu a troca de credenciais. Tente novamente.',
  oauth_unavailable: 'Não foi possível contatar o serviço de login do Google.',
  invalid_identity: 'O Google não retornou uma identidade válida.',
  identity_verification: 'Não foi possível validar a identidade do Google.',
};

function publishAuth(isAdmin) {
  window.dispatchEvent(new CustomEvent('mud-google-auth', { detail: { isAdmin } }));
}

async function refreshSession() {
  login.disabled = true;
  status.textContent = 'Verificando login Google…';
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) throw new Error('A sessão Google não pôde ser consultada.');
    const session = await response.json();
    const isAdmin = session.authenticated === true && session.isAdmin === true;
    publishAuth(isAdmin);
    if (session.authenticated === true) {
      status.textContent = isAdmin
        ? `Administrador conectado: ${session.email}`
        : `Conectado: ${session.email}. Sem acesso ao agente Luna.`;
      login.hidden = true;
      logout.hidden = false;
    } else if (session.configured === false) {
      status.textContent = 'Login Google não configurado. Configure as credenciais OAuth do MUD no servidor.';
      login.hidden = false;
      logout.hidden = true;
    } else {
      status.textContent = 'Entre com sua conta Google para habilitar o agente Luna.';
      login.hidden = false;
      logout.hidden = true;
    }
    login.disabled = session.configured === false;
  } catch (error) {
    publishAuth(false);
    status.textContent = error instanceof Error
      ? `${error.message} O login Google precisa ser configurado no servidor.`
      : 'O login Google precisa ser configurado no servidor.';
    login.hidden = false;
    login.disabled = true;
    logout.hidden = true;
  }
}

login.addEventListener('click', () => {
  window.location.assign('/api/auth/google/start');
});

logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível sair.');
    await refreshSession();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Não foi possível sair.';
  } finally {
    logout.disabled = false;
  }
});

const query = new URLSearchParams(window.location.search);
const authError = query.get('auth_error');
void refreshSession().then(() => {
  if (!authError) return;
  status.textContent = messages[authError] || 'O login Google não foi concluído.';
  window.history.replaceState({}, '', window.location.pathname);
});
