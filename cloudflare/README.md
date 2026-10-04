# Deploy Cloudflare

O Worker usa um Durable Object por conexão para a ponte TCP e `cloudflare:sockets` para conectar a `mud.fataldimensions.nl:4000`. As observações são encaminhadas para a API `/api/knowledge` na Vercel; somente a Vercel acessa o Turso. O Durable Object **não** é usado como banco de conhecimento nem recebe secrets do Turso.

Requer Wrangler autenticado (`npx wrangler login`) e uma conta Cloudflare com Durable Objects e TCP Sockets habilitados. Configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` como variáveis de ambiente no projeto Vercel `mud` (Settings → Environment Variables), e publique essa API antes do Worker. Nunca coloque os valores no Git nem no Cloudflare:

```sh
cd cloudflare
npx wrangler dev
npx wrangler deploy
```

`TURSO_DATABASE_URL` deve ser a URL `libsql://...` do banco. As tabelas são criadas automaticamente na primeira captura. O Worker encaminha respostas de `score`, `spells`, `effect`, `look`, `look map`, `alias`, `equip`/`equipment`, `examine`, `practice`, `help` e snapshots dos painéis de criação; senhas nunca são persistidas. Score mantém o snapshot estruturado atual e mudanças observadas; efeitos ativos, proficiência de feitiços e habilidades de `practice` são dados separados. `look` preserva sala, saídas e entidades observadas, usando descrição e saídas para distinguir salas homônimas; `look map` preserva o mapa. Caminhos só devem ser estruturados quando confirmados pelo jogo. O painel de criação vira um catálogo de opções/custos e uma seleção estruturada por perfil. Para sugestões, o resumo do perfil só é enviado ao GPT-4o quando o usuário ativa o consentimento na interface. `Dados salvos do personagem` permite consultar ou apagar os registros daquele perfil de navegador.

Comando inválido e resposta de jogo que o parser não reconhece são rejeitados pela API (`400` e `422`, respectivamente), não tratados como falha do Turso. O Worker registra categoria, status HTTP e código/motivo da API sem registrar o texto bruto do jogo; falhas de rede e respostas `5xx` são registradas separadamente. Para acompanhar os logs em tempo real, use `npx wrangler tail mud-fataldimensions`.
