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

## Base de conhecimento

Na ponte Cloudflare, respostas de `score`, `spells`, `alias`, `equip`, `examine <item>` e `help` são persistidas no Turso em tabelas de observações, equipamento, itens examinados, feitiços e perfil. O esquema é criado automaticamente. Além do texto original, `score` extrai atributos/recursos/armadura; `equip` registra slot e flags; `examine` registra nível, valor, armadura, efeitos e imunidades; `spells` registra proficiência e custo de mana. Efeitos examinados ficam separados dos atributos atuais do `score`: o sistema não presume que consegue calcular causalidade ou somar valores incompatíveis.

Os registros são separados por um identificador aleatório mantido no `localStorage` (não por conta/login), e a seção **Dados salvos do personagem** permite consultá-los e apagá-los. A captura é limitada aos comandos conhecidos; mensagens gerais, comandos privados e senhas não são persistidos. A ponte Cloudflare encaminha as observações para `/api/knowledge` na Vercel; somente a função da Vercel acessa o Turso. Configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` no projeto Vercel `mud`, nunca no Worker, navegador ou Git.

O Worker usa somente a URL pública da API Vercel, sem credenciais do banco. A versão local alternativa em Node mantém a base de conhecimento apenas na sessão; a persistência Turso é implementada na API Vercel usada pelo site.

## Copiloto e privacidade

O servidor chama `https://copilot-mtcporto.vercel.app/v1/chat/completions` com `gpt-4o`, sem chave. Depois do login, ative o compartilhamento: somente as mensagens posteriores entram no contexto (máximo de 12.000 caracteres), junto com os dados de personagem salvos no Turso. Desativar o compartilhamento cancela a solicitação em andamento. O serviço externo recebe esses dados quando você pede uma sugestão; não compartilhe informações privadas do jogo.

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
