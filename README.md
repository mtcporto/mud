# MUD / Copiloto

Cliente MUD em HTML, CSS e JavaScript. O site Vercel usa um Cloudflare Worker como ponte TCP/Telnet e o Turso para persistir os dados estruturados do personagem. A implementação Node.js abaixo é uma alternativa local.

## Rodar localmente

Requer Node.js 22.12 ou superior.

```sh
npm start
```

Abra http://127.0.0.1:3000. Opcionalmente copie `.env.example` para `.env`. Os destinos são configurados pelo operador em `MUD_TARGETS`; o navegador escolhe apenas um identificador. O destino padrão é Fatal Dimensions (disponibilidade e login não são garantidos).

```sh
npm run check
npm test
node tests/fixture.js
```

O último comando disponibiliza http://127.0.0.1:3123 com jogo e IA simulados para testar a interface, sem acessar contas reais. Não publique essa fixture. Os testes automatizados usam TCP local e respostas de IA simuladas.

### Cliente Telnet do agente (MVP)

O comando `npm run agent:luna` abre uma única sessão TCP/Telnet persistente para `mud.fataldimensions.nl:4000`, autentica, retoma a personagem de `AUTO-AFK` com Enter quando necessário, executa `look`, envia a observação para a mesma API `/api/knowledge` e desconecta. Ele usa `lib/telnet.js`, `lib/observations.js` por meio da API existente, e não altera o cliente web nem chama o LLM.

Configure `MUD_USERNAME`, `MUD_PASSWORD`, `MUD_PROFILE_ID` e, opcionalmente, `MUD_API_ORIGIN` no `.env` local ignorado pelo Git. O template sem credenciais está em `.env.agent.example`. Para unir registros do navegador, `MUD_PROFILE_ID` deve ser o UUID armazenado na chave `mud-copilot-profile` do `localStorage`; outro UUID grava no mesmo Turso, mas em perfil separado. O código nunca imprime a senha, inclui-a numa requisição de conhecimento ou retorna o transcript de login. Se usuário/senha estiverem ausentes, o cliente encerra com `MUD credentials are not configured.`. Não coloque a senha na conversa ou no repositório.

Para um teste limitado com IA via Telnet, use `npm run agent:luna:ai`. O controlador consulta a API de sugestões da Vercel e executa no máximo três ações informativas, de exame ou movimento; pausa diante de combate, movimento inválido ou HP abaixo de 50%, e rejeita ações fora dessa lista segura. Isso é um teste supervisionado e limitado, não um loop autônomo de leveling.

Para jogar autonomamente com Gemma via Ollama, use `npm run agent:luna:gemma`. Configure `MUD_USERNAME`, `MUD_PASSWORD`, `MUD_PROFILE_ID`, `OLLAMA_API_KEY` e, opcionalmente, `OLLAMA_MODEL`, `OLLAMA_BASE_URL`, `MUD_API_ORIGIN` e `MUD_AGENT_MAX_TURNS` no `.env` local. O modelo recebe a saída atual e a memória persistida do personagem a cada turno e escolhe livremente comandos de jogo; não há rota ou alvo de combate codificados. O loop para quando o score confirma nível 10, atinge o limite de turnos (1000 por padrão), ou o modelo propõe um comando composto/perigoso. A validação bloqueia comandos de conta, administrativos e destrutivos, mas não decide táticas de jogo pelo agente. Uma resposta inicial `look` fornece o estado da sala; respostas de movimento, skills, quests, exits, consider e diálogo público também alimentam a base de conhecimento. Interrompa a sessão com Ctrl+C.

Para inspecionar manualmente o protocolo Telnet, desconecte Luna no cliente web e execute `node --env-file-if-exists=.env scripts/telnet-debug.js` (ou `npm run telnet:debug` com `.env` local). Não carregue credenciais de `.env.example`. O diagnóstico oculta todo o texto durante nome/senha; após enviar a senha, exibe a saída decodificada e aceita respostas/comandos pelo terminal, sem chamar IA nem API de conhecimento. Senhas refletidas pelo servidor são mascaradas.

## Base de conhecimento

### Login Google e acesso ao agente

O botão **Entrar com Google** usa o projeto OAuth compartilhado `umbrella-mtcporto`, mas o MUD deve ter seu próprio cliente OAuth e segredo, como recomendado pelo projeto Umbrella para manter sessões isoladas entre aplicativos. No Google Cloud Console, crie um cliente Web para o MUD dentro desse projeto e configure a origem autorizada `https://mud-indol.vercel.app` e o redirecionamento autorizado `https://mud-indol.vercel.app/api/auth/google/callback`. No Vercel do MUD, configure `APP_URL=https://mud-indol.vercel.app`, `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`; o segredo fica somente no servidor. Para uso local, use um cliente/redirect local autorizado e `APP_URL=http://127.0.0.1:3000` no `.env`.

O callback valida state, nonce, PKCE, assinatura/issuer/audience e e-mail verificado do Google antes de emitir um cookie HttpOnly, Secure em HTTPS, SameSite=Lax e com validade de sete dias. O backend determina admin comparando o e-mail verificado com `mtcporto@gmail.com`; o botão Luna só aparece para essa conta, e `/api/agent-decision` também exige a sessão admin — esconder o botão não é a proteção de acesso. O logout apaga a sessão. Outras contas Google podem entrar, mas não recebem controle do agente. O cliente OAuth e a sessão do MUD são independentes dos usados por Mosaico ou Productivity, embora compartilhem o projeto/brand Umbrella.

### Agente autônomo pela interface web

Conecte Luna e faça login normalmente; pressione **Ligar agente Luna** para iniciar, e pressione novamente para parar. No backend Vercel configure `OLLAMA_API_KEY` e, opcionalmente, `OLLAMA_MODEL`/`OLLAMA_BASE_URL`; a chave fica no servidor e não é solicitada nem armazenada no navegador. O agente usa a conexão Telnet já aberta, executa `look` para observar a sala atual e decide ações sozinho até confirmar nível 10, atingir o limite de turnos, ocorrer um erro ou o usuário desligá-lo. A aba do navegador e a conexão precisam permanecer abertas; fechar a aba encerra a execução. A API aceita apenas origens do aplicativo e aplica intervalo mínimo entre decisões. O modo web exige que o prompt ROM com HP/movimento tenha sido detectado após o login.

Na ponte Cloudflare, respostas de `score`, `spells`, `effect`, `look`, `look map`, `alias`, `equip`/`equipment`, `examine <item>`, `practice`, `help`, `skills`, comandos de quest, `exit`/`exits`, `consider`, `where`, `hunt`, `say` e `gossip`, além do painel de criação, são persistidas no Turso. O esquema é criado automaticamente. `score` extrai atributos base/modificados, recursos, armadura, alinhamento, fome, sede, adrenalina, embriaguez, exploração, ouro, prata, hitroll e damroll; `mud_profiles.score_json` é o snapshot atual e `mud_observations` conserva a observação mais recente por comando e assunto. Snapshots estruturados diferentes são mantidos em `mud_score_history` para comparar mudanças sem presumir sua causa. `equip` e `equipment` registram slot e flags; `examine` registra nível, valor, armadura, efeitos e imunidades e usa o alvo do comando quando o jogo não repete o nome do objeto. Respostas malsucedidas de exame são descartadas. `spells` registra proficiência/custo de mana aprendidos, `practice` registra proficiências e sessões restantes, e `effect` registra separadamente os efeitos ativos observados. `look` guarda nome, descrição, entidades visíveis e saídas; respostas que descrevem uma sala após movimento são registradas da mesma forma. A chave também considera a descrição estática e as saídas para evitar colisões entre salas homônimas. `look map` guarda o mapa textual e suas linhas para apoiar a exploração sem inventar ligações entre locais. Comando inválido retorna `400`; saída do jogo que não pode ser interpretada retorna `422`. O Worker registra categoria, status e motivo da rejeição sem incluir o texto bruto do jogo; falhas de rede/servidor aparecem como falhas de persistência separadas.

As tabelas `mud_creation_options` e `mud_creation_skill_catalog` guardam o catálogo observado; `mud_character_builds` e `mud_character_skill_choices` registram a seleção de cada perfil; `mud_creation_xp_curve` guarda os custos de XP. A resposta atual de `effect` fica estruturada em `mud_observations.data_json`, com nomes de feitiços mesmo quando o jogo não mostra modificadores numéricos; o texto original também é preservado. Os marcadores de seleção (`[X]`, `[x]`, `[*]` e `[ ]`) são preservados como estados distintos. A senha não é armazenada: para o painel de criação, o texto bruto é descartado e somente os campos estruturados são persistidos. O score mostra o estado efetivo observado naquele instante; efeitos ativos e bônus de itens ficam separados, pois o jogo pode aplicar regras de acúmulo, requisitos de alinhamento e alterações por ações. O copiloto pode comparar snapshots, mas não atribui causa sem evidência.

Os registros são separados por um identificador aleatório mantido no `localStorage` (não por conta/login), e a seção **Dados salvos do personagem** permite consultá-los e apagá-los. A captura é limitada aos comandos conhecidos; comandos privados e senhas não são persistidos. `say` e `gossip` são diálogos públicos e ficam armazenados como observações. A ponte Cloudflare encaminha as observações para `/api/knowledge` na Vercel; somente a função da Vercel acessa o Turso. Configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` no projeto Vercel `mud`, nunca no Worker, navegador ou Git.

O Worker usa somente a URL pública da API Vercel, sem credenciais do banco. A versão local alternativa em Node mantém a base de conhecimento apenas na sessão; a persistência Turso é implementada na API Vercel usada pelo site.

## Copiloto e privacidade

Por padrão, o servidor chama `https://copilot-mtcporto.vercel.app/v1/chat/completions` com `gpt-4o`, sem chave. Para usar outro serviço compatível com a API OpenAI, configure `AI_BASE_URL` (a URL base ou o endpoint `/chat/completions`) e `AI_MODEL` no projeto Vercel `mud`; URLs devem usar HTTPS, exceto serviços HTTP em localhost. `IA_BASE_URL` e `MODEL` continuam aceitos como nomes antigos na configuração local. A página envia sugestões para a API da Vercel, que chama o serviço configurado no servidor; a Cloudflare Worker continua responsável pelo WebSocket do MUD. Depois do login, ative o compartilhamento: somente as mensagens posteriores entram no contexto (máximo de 12.000 caracteres), junto com os dados de personagem salvos no Turso. Desativar o compartilhamento cancela a solicitação em andamento. O serviço externo recebe esses dados quando você pede uma sugestão; não compartilhe informações privadas do jogo.

Cada sugestão precisa de aprovação manual. Não existe execução autônoma. A resposta é validada e uma mudança no cenário invalida sugestões pendentes. Texto do jogo e da IA é exibido com `textContent`, nunca como HTML.

Marque **Entrada privada** antes de enviar senha. Ela não é ecoada pelo cliente nem adicionada ao histórico de comandos; a análise é desligada. Prompts comuns de senha e negociação Telnet ECHO também ativam esse modo, mas não substituem a escolha manual em jogos com prompts diferentes. Não há armazenamento de mensagens gerais, senhas ou histórico no navegador ou no Turso; apenas o identificador aleatório do perfil fica no `localStorage`. O servidor conserva um buffer limitado de saída do jogo para reconectar o canal de mensagens; o próprio jogo pode ecoar informações que você enviar. Telnet é TCP sem criptografia entre a ponte e o jogo.

## Proteções e limites

- Destinos definidos no servidor, resolução IPv4 validada contra redes privadas/reservadas e conexão ao IP validado.
- Cookie de sessão aleatório, HttpOnly e SameSite=Strict; Secure sob HTTPS. Cada navegador acessa apenas sua própria sessão. Isso não é um sistema de contas.
- Origem exata para POST, CSP restritiva, limites de corpo, comandos, conexões e chamadas de IA; erros sem detalhes internos.
- Até 100 sessões, três conexões por IP, seis tentativas/minuto por IP, 30 comandos/10 segundos e uma sugestão/10 segundos por sessão.
- Sessão expira após 30 minutos sem ação; abandonar o canal de mensagens por 90 segundos também encerra a conexão (verificação a cada 15 segundos).
- Reconectar SSE mantém a conexão TCP e repete a saída recente. Reiniciar o processo encerra as sessões. Uma aba por sessão é suportada.

## Hospedagem

O Worker ativo está em `cloudflare/`. Consulte [cloudflare/README.md](./cloudflare/README.md) para configurar secrets do Turso e publicar alterações. O processo Node local não persiste observações no Turso.
