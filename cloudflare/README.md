# Deploy Cloudflare

Esta variante usa Workers Static Assets para a interface, um Durable Object por sessão e `cloudflare:sockets` para a conexão TCP persistente com `mud.fataldimensions.nl:4000`.

Requer Wrangler autenticado (`npx wrangler login`) e uma conta Cloudflare com Durable Objects e TCP Sockets habilitados:

```sh
cd cloudflare
npx wrangler dev
npx wrangler deploy
```

O Worker não usa Turso ainda. A base de conhecimento entra numa segunda etapa, depois de confirmar o comportamento da conexão real. O Durable Object atual isola uma sessão por conexão e fecha o socket quando o navegador sai.
