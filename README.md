# MUD / Copiloto

Cliente MUD em HTML, CSS e JavaScript, com uma ponte persistente Node.js → TCP/Telnet. Sem dependências npm de produção ou desenvolvimento. O único cliente é `index.html`; o antigo `mud-client.html` e os proxies WebSocket públicos foram removidos.

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

O servidor reconhece respostas posteriores a `score`, `spells`, `alias`, `equip` e `examine <item>`. Elas ficam estruturadas na sessão e podem ser consultadas em `GET /api/knowledge`; por enquanto são memória temporária, apagada ao desconectar ou reiniciar. Esse é o primeiro contrato para persistir depois em Turso: perfil do personagem, feitiços, aliases, equipamento e atributos de itens examinados. A captura não tenta adivinhar campos nem trata texto arbitrário como dado confiável.

## Copiloto e privacidade

O servidor chama `https://copilot-mtcporto.vercel.app/v1/chat/completions` com `gpt-4o`, sem chave. Depois do login, ative o compartilhamento e use `look`: somente as mensagens posteriores entram no contexto (máximo de 12.000 caracteres). Desativar o compartilhamento apaga o contexto e cancela a solicitação em andamento. O serviço externo recebe esse texto; não compartilhe dados privados do jogo.

Cada sugestão precisa de aprovação manual. Não existe execução autônoma. A resposta é validada e uma mudança no cenário invalida sugestões pendentes. Texto do jogo e da IA é exibido com `textContent`, nunca como HTML.

Marque **Entrada privada** antes de enviar senha. Ela não é ecoada pelo cliente nem adicionada ao histórico de comandos; a análise é desligada. Prompts comuns de senha e negociação Telnet ECHO também ativam esse modo, mas não substituem a escolha manual em jogos com prompts diferentes. Não há armazenamento em disco ou localStorage de mensagens, senhas ou histórico. O servidor conserva um buffer limitado de saída do jogo para reconectar o canal de mensagens; o próprio jogo pode ecoar informações que você enviar. Telnet é TCP sem criptografia entre a ponte e o jogo.

## Proteções e limites

- Destinos definidos no servidor, resolução IPv4 validada contra redes privadas/reservadas e conexão ao IP validado.
- Cookie de sessão aleatório, HttpOnly e SameSite=Strict; Secure sob HTTPS. Cada navegador acessa apenas sua própria sessão. Isso não é um sistema de contas.
- Origem exata para POST, CSP restritiva, limites de corpo, comandos, conexões e chamadas de IA; erros sem detalhes internos.
- Até 100 sessões, três conexões por IP, seis tentativas/minuto por IP, 30 comandos/10 segundos e uma sugestão/10 segundos por sessão.
- Sessão expira após 30 minutos sem ação; abandonar o canal de mensagens por 90 segundos também encerra a conexão (verificação a cada 15 segundos).
- Reconectar SSE mantém a conexão TCP e repete a saída recente. Reiniciar o processo encerra as sessões. Uma aba por sessão é suportada.

## Hospedagem — decisão pendente

Esta arquitetura precisa de um processo Node persistente com saída TCP liberada e proxy reverso HTTPS que suporte SSE sem buffering. O deploy estático/serverless anterior na Vercel não executa esta ponte. **Não promover este rework sobre o site atual antes de escolher a hospedagem.**

Em produção configure `NODE_ENV=production`, `PUBLIC_ORIGIN` com a origem HTTPS exata e `HOST` conforme a rede do servidor. Use uma única instância inicialmente: sessões e limites ficam em memória. Cabeçalhos de IP encaminhados não são confiados; atrás de um proxy, limites por IP podem ser compartilhados por todos os usuários. Antes de publicação, ajustar isso à hospedagem escolhida e testar HTTPS/cookies/SSE e a conexão real ao jogo. Para múltiplas instâncias será necessário projetar afinidade de sessão e limites compartilhados.
