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

O comando `npm run agent:luna` abre uma única sessão TCP/Telnet persistente para `mud.fataldimensions.nl:4000`, autentica, executa `look`, envia a observação para a mesma API `/api/knowledge` e desconecta. Ele usa `lib/telnet.js`, `lib/observations.js` por meio da API existente, e não altera o cliente web nem chama o LLM.

Configure `MUD_USERNAME`, `MUD_PASSWORD`, `MUD_PROFILE_ID` e, opcionalmente, `MUD_API_ORIGIN` no `.env` local ignorado pelo Git. O template sem credenciais está em `.env.agent.example`. Para unir registros do navegador, `MUD_PROFILE_ID` deve ser o UUID armazenado na chave `mud-copilot-profile` do `localStorage`; outro UUID grava no mesmo Turso, mas em perfil separado. O código nunca imprime a senha, inclui-a numa requisição de conhecimento ou retorna o transcript de login. Se usuário/senha estiverem ausentes, o cliente encerra com `MUD credentials are not configured.`. Não coloque a senha na conversa ou no repositório.

## Base de conhecimento

Na ponte Cloudflare, respostas de `score`, `spells`, `effect`, `look`, `look map`, `alias`, `equip`/`equipment`, `examine <item>`, `practice`, `help` e o painel de criação são persistidos no Turso. O esquema é criado automaticamente. `score` extrai atributos base/modificados, recursos, armadura, alinhamento, fome, sede, adrenalina, embriaguez, exploração, ouro, prata, hitroll e damroll; `mud_profiles.score_json` é o snapshot atual e `mud_observations` conserva a observação mais recente por comando e assunto. Snapshots estruturados diferentes são mantidos em `mud_score_history` para comparar mudanças sem presumir sua causa. `equip` e `equipment` registram slot e flags; `examine` registra nível, valor, armadura, efeitos e imunidades e usa o alvo do comando quando o jogo não repete o nome do objeto. Respostas malsucedidas de exame são descartadas. `spells` registra proficiência/custo de mana aprendidos, `practice` registra proficiências e sessões restantes, e `effect` registra separadamente os efeitos ativos observados. `look` guarda nome, descrição, entidades visíveis e saídas; a chave também considera a descrição estática e as saídas para evitar colisões entre salas homônimas. `look map` guarda o mapa textual e suas linhas para apoiar a exploração sem inventar ligações entre locais. Comando inválido retorna `400`; saída do jogo que não pode ser interpretada retorna `422`. O Worker registra categoria, status e motivo da rejeição sem incluir o texto bruto do jogo; falhas de rede/servidor aparecem como falhas de persistência separadas.

As tabelas `mud_creation_options` e `mud_creation_skill_catalog` guardam o catálogo observado; `mud_character_builds` e `mud_character_skill_choices` registram a seleção de cada perfil; `mud_creation_xp_curve` guarda os custos de XP. A resposta atual de `effect` fica estruturada em `mud_observations.data_json`, com nomes de feitiços mesmo quando o jogo não mostra modificadores numéricos; o texto original também é preservado. Os marcadores de seleção (`[X]`, `[x]`, `[*]` e `[ ]`) são preservados como estados distintos. A senha não é armazenada: para o painel de criação, o texto bruto é descartado e somente os campos estruturados são persistidos. O score mostra o estado efetivo observado naquele instante; efeitos ativos e bônus de itens ficam separados, pois o jogo pode aplicar regras de acúmulo, requisitos de alinhamento e alterações por ações. O copiloto pode comparar snapshots, mas não atribui causa sem evidência.

Os registros são separados por um identificador aleatório mantido no `localStorage` (não por conta/login), e a seção **Dados salvos do personagem** permite consultá-los e apagá-los. A captura é limitada aos comandos conhecidos; mensagens gerais, comandos privados e senhas não são persistidos. A ponte Cloudflare encaminha as observações para `/api/knowledge` na Vercel; somente a função da Vercel acessa o Turso. Configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` no projeto Vercel `mud`, nunca no Worker, navegador ou Git.

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
