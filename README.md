# Projeto Profissional - Choque de Gestao

Esta pasta inicia a nova versao profissional da plataforma:

- SaaS multi-loja;
- assinatura via Asaas;
- webhook para liberar/bloquear lojas;
- futura integracao com Supabase.

## Webhook Asaas

URL no Netlify:

```text
https://app.choquedegestao.com/.netlify/functions/asaas-webhook
```

O Asaas envia o token do webhook no header:

```text
asaas-access-token
```

Configure no Netlify:

```env
ASAAS_ENVIRONMENT=sandbox
ASAAS_WEBHOOK_TOKEN=token_final_salvo_no_asaas
```

## Publicacao

Publique esta pasta como um novo site Netlify ou conecte a um repositorio Git.

Depois que publicar, teste no navegador:

```text
https://app.choquedegestao.com/.netlify/functions/asaas-webhook
```

Se responder com `ok: true`, volte ao Asaas e salve/ative o webhook.
