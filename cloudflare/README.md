# Deploy Cloudflare

O Worker usa um Durable Object por conexão para a ponte TCP e `cloudflare:sockets` para conectar a `mud.fataldimensions.nl:4000`. As observações são encaminhadas para a API `/api/knowledge` na Vercel; somente a Vercel acessa o Turso. O Durable Object **não** é usado como banco de conhecimento nem recebe secrets do Turso.

Requer Wrangler autenticado (`npx wrangler login`) e uma conta Cloudflare com Durable Objects e TCP Sockets habilitados. Configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` como variáveis de ambiente no projeto Vercel `mud` (Settings → Environment Variables), e publique essa API antes do Worker. Nunca coloque os valores no Git nem no Cloudflare:

```sh
cd cloudflare
npx wrangler dev
npx wrangler deploy
```

`TURSO_DATABASE_URL` deve ser a URL `libsql://...` do banco. As tabelas são criadas automaticamente na primeira captura. O Worker encaminha respostas dos comandos reconhecidos e snapshots dos painéis de criação; senhas nunca são persistidas. O painel vira um catálogo de opções/custos e uma seleção estruturada por perfil. Para sugestões, o resumo do perfil só é enviado ao GPT-4o quando o usuário ativa o consentimento na interface. `Dados salvos do personagem` permite consultar ou apagar os registros daquele perfil de navegador.
